import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import * as diff from 'diff'

// 定义正则表达式来检测 AI 生成和修改的代码块
const AI_REGION_START = /\/\/ #region @ai_generated(?:\s+id:([a-f0-9]{8}))?/
const AI_MODIFIED_START = /\/\/ #region @ai_modified\((\d+)%\)(?:\s+id:([a-f0-9]{8}))?/
const AI_REGION_END = /\/\/ #endregion/

// 元数据接口
interface BlockMetadata {
  originalContent: string
  lastModifiedContent: string
  startLine?: number // 最后一次已知的起始行
  endLine?: number // 最后一次已知的结束行
  lastUpdated: number // 时间戳，用于清理过期条目
  _documentVersion?: number
}

interface FileMetadata {
  _documentVersion: number
  [key: string]: BlockMetadata
}

// 全局元数据缓存的类型定义
interface MetadataCache {
  [filePath: string]: FileMetadata
}

// 全局元数据缓存
let metadataCache: MetadataCache = {}
const METADATA_FILE = '.ai_code_tracker_metadata.json'

// 活动文档快照，用于恢复计算修改百分比
const documentSnapshots: { [filePath: string]: string } = {}

export function activate(context: vscode.ExtensionContext) {
  console.warn('activate')
  vscode.window.showInformationMessage('AI Code Tracker activated')

  // 注册文件保存事件
  const onSaveDocument = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (isSupportedFileType(document)) {
      await processDocument(document)
      // 更新文档快照
      documentSnapshots[document.uri.fsPath] = document.getText()
    }
  })

  // 注册文件打开事件
  const onOpenDocument = vscode.workspace.onDidOpenTextDocument(async (document) => {
    if (isSupportedFileType(document)) {
      await loadMetadata(document)
      await scanAiBlocks(document, true)
      // 创建文档快照
      documentSnapshots[document.uri.fsPath] = document.getText()
    }
  })

  // 注册文档关闭事件以清理缓存
  const onCloseDocument = vscode.workspace.onDidCloseTextDocument((document) => {
    const filePath = document.uri.fsPath
    delete documentSnapshots[filePath]
  })

  context.subscriptions.push(onSaveDocument, onOpenDocument, onCloseDocument)

  // 初始化：处理当前已打开的文档
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document
    if (isSupportedFileType(document)) {
      loadMetadata(document).then(() => {
        scanAiBlocks(document, true)
        documentSnapshots[document.uri.fsPath] = document.getText()
      })
    }
  }
}

// 判断文件类型是否支持
function isSupportedFileType(document: vscode.TextDocument): boolean {
  console.warn('isSupportedFileType')
  return ['javascript', 'typescript', 'vue'].includes(document.languageId)
}

// 生成块ID - 使用内容的哈希值
function generateBlockId(content: string): string {
  console.warn('generateBlockId')
  const hash = crypto.createHash('md5').update(cleanCodeForHashing(content)).digest('hex')
  return hash.substring(0, 8) // 使用前8位作为ID，足够唯一且较短
}

// 扫描文档中的 AI 代码块
async function scanAiBlocks(document: vscode.TextDocument, updateMetadata: boolean = false) {
  console.warn('scanAiBlocks')
  const text = document.getText()
  const lines = text.split('\n')
  const filePath = document.uri.fsPath

  if (!metadataCache[filePath]) {
    metadataCache[filePath] = { _documentVersion: document.version }
  }

  // 存储当前扫描到的所有块ID，用于清理不再存在的块
  const foundBlockIds = new Set<string>()

  let inBlock = false
  let blockStartLine = -1
  let currentBlockId = ''
  let blockContent = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!inBlock) {
      // 检查是否是 AI 生成或修改的代码块开始
      const genMatch = AI_REGION_START.exec(line)
      const modMatch = AI_MODIFIED_START.exec(line)

      if (genMatch || modMatch) {
        inBlock = true
        blockStartLine = i
        blockContent = ''

        // 尝试提取ID，如果存在
        currentBlockId = (genMatch && genMatch[1]) || (modMatch && modMatch[2]) || ''
      }
    }
    else if (AI_REGION_END.test(line)) {
      // 代码块结束
      inBlock = false
      const cleanContent = cleanCodeForHashing(blockContent)

      // 如果没有ID，生成一个
      if (!currentBlockId) {
        currentBlockId = generateBlockId(blockContent)
      }

      foundBlockIds.add(currentBlockId)

      // 如果是更新操作，更新或创建元数据
      if (updateMetadata) {
        if (!metadataCache[filePath][currentBlockId]) {
          // 新的代码块
          metadataCache[filePath][currentBlockId] = {
            originalContent: cleanContent,
            lastModifiedContent: cleanContent,
            startLine: blockStartLine,
            endLine: i,
            lastUpdated: Date.now(),
          }
        }
        else {
          // 更新位置信息
          metadataCache[filePath][currentBlockId].startLine = blockStartLine
          metadataCache[filePath][currentBlockId].endLine = i
          metadataCache[filePath][currentBlockId].lastUpdated = Date.now()
          metadataCache[filePath][currentBlockId]._documentVersion = document.version
        }
      }

      currentBlockId = ''
    }
    else if (inBlock) {
      blockContent += `${line}\n`
    }
  }

  // 清理不再存在的块，但只在更新操作时
  if (updateMetadata) {
    // 筛选需要保留的元数据
    const newMetadata: FileMetadata = { _documentVersion: document.version }

    // 只保留找到的块和最近更新过的块（避免意外删除临时移除的块）
    const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000 // 1周前

    for (const blockId in metadataCache[filePath]) {
      // 跳过特殊字段
      if (blockId === '_documentVersion') {
        continue
      }

      const metadata = metadataCache[filePath][blockId] as BlockMetadata
      if (foundBlockIds.has(blockId) || metadata.lastUpdated > cutoffTime) {
        newMetadata[blockId] = metadata
      }
    }

    metadataCache[filePath] = newMetadata
    await saveMetadata(document)
  }
}

// 处理文档中的 AI 代码块，更新修改状态
async function processDocument(document: vscode.TextDocument) {
  console.warn('processDocument')
  const text = document.getText()
  const lines = text.split('\n')
  const filePath = document.uri.fsPath

  if (!metadataCache[filePath]) {
    await loadMetadata(document)
    if (!metadataCache[filePath]) {
      metadataCache[filePath] = { _documentVersion: document.version }
    }
  }

  // 首先扫描文档，更新元数据中的位置信息
  await scanAiBlocks(document, false)

  let inBlock = false
  let blockStartLine = -1
  let currentBlockId = ''
  let blockContent = ''
  const blocksToUpdate: Array<{
    startLine: number
    endLine: number
    blockId: string
    content: string
    modificationPercent: number
    shouldRemove: boolean
    isGenerated: boolean
  }> = []

  // 扫描文档中的代码块
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!inBlock) {
      // 检查代码块开始
      const genMatch = AI_REGION_START.exec(line)
      const modMatch = AI_MODIFIED_START.exec(line)

      if (genMatch || modMatch) {
        inBlock = true
        blockStartLine = i
        blockContent = ''
        currentBlockId = (genMatch && genMatch[1]) || (modMatch && modMatch[2]) || ''
      }
    }
    else if (AI_REGION_END.test(line)) {
      // 检查代码块结束
      inBlock = false
      const blockEnd = i
      const cleanContent = cleanCodeForHashing(blockContent)
      const isGenerated = AI_REGION_START.test(lines[blockStartLine])

      // 如果没有ID，生成一个
      if (!currentBlockId) {
        currentBlockId = generateBlockId(blockContent)
      }

      // 检查是否需要更新元数据和计算修改率
      if (!metadataCache[filePath][currentBlockId]) {
        // 新块，添加元数据
        metadataCache[filePath][currentBlockId] = {
          originalContent: cleanContent,
          lastModifiedContent: cleanContent,
          startLine: blockStartLine,
          endLine: blockEnd,
          lastUpdated: Date.now(),
        }

        // 不需要更新注释，因为这是新的块
      }
      else {
        // 现有块，计算修改百分比
        const metadata = metadataCache[filePath][currentBlockId] as BlockMetadata
        const originalContent = metadata.originalContent
        const modificationPercent = calculateModificationPercentage(originalContent, cleanContent)

        // 更新最后修改内容
        metadata.lastModifiedContent = cleanContent
        metadata.startLine = blockStartLine
        metadata.endLine = blockEnd
        metadata.lastUpdated = Date.now()

        // 如果有修改，准备更新注释
        const threshold = vscode.workspace.getConfiguration('aiCodeTracker').get('modificationThreshold', 60)

        blocksToUpdate.push({
          startLine: blockStartLine,
          endLine: blockEnd,
          blockId: currentBlockId,
          content: cleanContent,
          modificationPercent,
          shouldRemove: modificationPercent >= threshold,
          isGenerated,
        })
      }

      currentBlockId = ''
    }
    else if (inBlock) {
      blockContent += `${line}\n`
    }
  }

  // 应用更新
  if (blocksToUpdate.length > 0) {
    const edit = new vscode.WorkspaceEdit()

    // 倒序处理以避免行号变化影响
    blocksToUpdate.sort((a, b) => b.startLine - a.startLine)

    for (const block of blocksToUpdate) {
      const { startLine, endLine, blockId, modificationPercent, shouldRemove, isGenerated } = block

      if (shouldRemove) {
        // 删除标记
        edit.delete(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
        )
        edit.delete(
          document.uri,
          new vscode.Range(endLine, 0, endLine + 1, 0),
        )

        // 从元数据中删除
        delete metadataCache[filePath][blockId]
      }
      else if (modificationPercent > 0 && isGenerated) {
        // 如果是 AI 生成的代码块且有修改，更新为修改状态
        edit.replace(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
                  `// #region @ai_modified(${Math.round(modificationPercent)}%) id:${blockId}\n`,
        )
      }
      else if (modificationPercent > 0 && !isGenerated) {
        // 如果是已修改的代码块，只更新百分比
        edit.replace(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
                  `// #region @ai_modified(${Math.round(modificationPercent)}%) id:${blockId}\n`,
        )
      }
      else if (isGenerated) {
        // 如果是未修改的AI生成代码块，但没有ID，添加ID
        if (!lines[startLine].includes('id:')) {
          edit.replace(
            document.uri,
            new vscode.Range(startLine, 0, startLine + 1, 0),
                      `// #region @ai_generated id:${blockId}\n`,
          )
        }
      }
    }

    await vscode.workspace.applyEdit(edit)
    await saveMetadata(document)
  }
}

// 清理代码以进行比较（去除空格和注释）
function cleanCodeForHashing(code: string): string {
  console.warn('cleanCodeForHashing')
  // 移除单行注释
  code = code.replace(/\/\/.*$/gm, '')
  // 移除多行注释
  code = code.replace(/\/\*[\s\S]*?\*\//g, '')
  // 移除空白行和行首尾空白
  code = code.replace(/^\s+|\s+$/gm, '')
  code = code.replace(/\n\s*\n/g, '\n')

  return code.trim()
}

// 计算修改百分比
function calculateModificationPercentage(originalContent: string, currentContent: string): number {
  console.warn('calculateModificationPercentage')
  if (originalContent === currentContent) {
    return 0
  }

  originalContent = cleanCodeForHashing(originalContent)
  currentContent = cleanCodeForHashing(currentContent)

  if (originalContent === currentContent) {
    return 0 // 只有空格或注释的变化
  }

  const changes = diff.diffLines(originalContent, currentContent)
  let addedLines = 0
  let removedLines = 0
  let unchangedLines = 0

  for (const part of changes) {
    // 计算非空行的数量
    const nonEmptyLines = (part.value.match(/\S+/g) || []).length

    if (part.added) {
      addedLines += nonEmptyLines
    }
    else if (part.removed) {
      removedLines += nonEmptyLines
    }
    else {
      unchangedLines += nonEmptyLines
    }
  }

  const totalOriginalLines = unchangedLines + removedLines
  if (totalOriginalLines === 0) {
    return currentContent.length > 0 ? 100 : 0
  }

  // 计算修改百分比 - 考虑添加和删除的行
  const changeRatio = (addedLines + removedLines) / (2 * totalOriginalLines)
  return Math.min(100, Math.max(0, Math.round(changeRatio * 100)))
}

// 保存元数据到工作区文件
async function saveMetadata(document: vscode.TextDocument) {
  console.warn('saveMetadata')
  const filePath = document.uri.fsPath

  if (!metadataCache[filePath] || Object.keys(metadataCache[filePath]).length <= 1) {
    return // 只有 _documentVersion 不存储
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!workspaceFolder) {
    return
  }

  const metadataPath = path.join(workspaceFolder.uri.fsPath, METADATA_FILE)

  try {
    // 明确定义allMetadata的类型
    let allMetadata: { [filePath: string]: FileMetadata } = {}

    // 尝试读取现有元数据
    if (fs.existsSync(metadataPath)) {
      const data = fs.readFileSync(metadataPath, 'utf8')
      try {
        allMetadata = JSON.parse(data)
      }
      catch (e) {
        console.error('Failed to parse metadata file, creating new one')
      }
    }

    // 只保留有效的块元数据
    const cleanMetadata: FileMetadata = {}
    for (const blockId in metadataCache[filePath]) {
      if (blockId !== '_documentVersion') {
        cleanMetadata[blockId] = metadataCache[filePath][blockId] as BlockMetadata
      }
    }

    // 只有当有实际的块元数据时才更新全局元数据
    if (Object.keys(cleanMetadata).length > 0) {
      allMetadata[filePath] = cleanMetadata
    }
    else {
      // 如果没有块，则删除文件的元数据条目
      delete allMetadata[filePath]
    }

    // 写入文件
    fs.writeFileSync(metadataPath, JSON.stringify(allMetadata, null, 2))
  }
  catch (error) {
    console.error('Failed to save metadata:', error)
  }
}

// 从工作区文件加载元数据
async function loadMetadata(document: vscode.TextDocument) {
  console.warn('loadMetadata')
  const filePath = document.uri.fsPath
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)

  if (!workspaceFolder) {
    return
  }

  const metadataPath = path.join(workspaceFolder.uri.fsPath, METADATA_FILE)

  try {
    if (fs.existsSync(metadataPath)) {
      const data = fs.readFileSync(metadataPath, 'utf8')
      const allMetadata: { [filePath: string]: FileMetadata } = JSON.parse(data)

      if (allMetadata[filePath]) {
        // 创建新对象以便添加_documentVersion
        const fileMetadata: FileMetadata = { ...allMetadata[filePath] }
        fileMetadata._documentVersion = document.version
        metadataCache[filePath] = fileMetadata
      }
      else {
        metadataCache[filePath] = { _documentVersion: document.version }
      }
    }
    else {
      metadataCache[filePath] = { _documentVersion: document.version }
    }
  }
  catch (error) {
    console.error('Failed to load metadata:', error)
    metadataCache[filePath] = { _documentVersion: document.version }
  }
}

export function deactivate() {
  console.warn('deactivate')
  // 清理资源
  metadataCache = {}
  Object.keys(documentSnapshots).forEach(key => delete documentSnapshots[key])
}
