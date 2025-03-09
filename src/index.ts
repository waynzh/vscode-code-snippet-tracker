import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import * as diff from 'diff'

// 定义正则表达式来检测 AI 生成和修改的代码块
const AI_GENERATED_RE = /\/\/ #region @ai_generated(?:\s+id:([a-f0-9]{6}))?/
const AI_MODIFIED_RE = /\/\/ #region @ai_modified\((\d+%\))(?:\s+id:([a-f0-9]{6}))?/
const AI_REGION_END = /\/\/ #endregion/

// 存储上一次保存的代码块内容
interface BlockInfo {
  id: string
  content: string
  isGenerated: boolean
  modifiedPercent?: number
}

// 保存文件之前的代码块快照
let lastBlockSnapshots: { [filePath: string]: { [blockId: string]: string } } = {}

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('AI Code Tracker activated')

  // 注册文件保存事件
  const onSaveDocument = vscode.workspace.onDidSaveTextDocument((document) => {
    if (isSupportedFileType(document)) {
      processDocument(document)
    }
  })

  // 注册文件打开事件
  const onOpenDocument = vscode.workspace.onDidOpenTextDocument((document) => {
    if (isSupportedFileType(document)) {
      // 初始化文件的代码块快照
      captureBlockSnapshots(document)
    }
  })

  // 注册文档关闭事件以清理缓存
  const onCloseDocument = vscode.workspace.onDidCloseTextDocument((document) => {
    delete lastBlockSnapshots[document.uri.fsPath]
  })

  context.subscriptions.push(onSaveDocument, onOpenDocument, onCloseDocument)

  // 初始化：处理当前已打开的文档
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document
    if (isSupportedFileType(document)) {
      captureBlockSnapshots(document)
    }
  }
}

// 判断文件类型是否支持
function isSupportedFileType(document: vscode.TextDocument): boolean {
  return ['javascript', 'typescript', 'vue'].includes(document.languageId)
}

// 生成短ID (6字符即可，文件内唯一)
function generateShortId(): string {
  return crypto.randomBytes(3).toString('hex')
}

// 捕获文件中所有代码块的快照
function captureBlockSnapshots(document: vscode.TextDocument): void {
  const filePath = document.uri.fsPath
  const text = document.getText()
  const blocks = extractAllCodeBlocks(text)

  lastBlockSnapshots[filePath] = {}

  // 保存所有代码块的内容
  blocks.forEach((block) => {
    if (block.id) {
      lastBlockSnapshots[filePath][block.id] = block.content
    }
  })
}

// 从文本中提取所有代码块信息
function extractAllCodeBlocks(text: string): BlockInfo[] {
  const lines = text.split('\n')
  const blocks: BlockInfo[] = []

  let inBlock = false
  let currentBlockId = ''
  let blockContent = ''
  let isGenerated = false
  let modifiedPercent: number | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!inBlock) {
      // 检查是否是AI生成的代码块开始
      const genMatch = AI_GENERATED_RE.exec(line)
      if (genMatch) {
        inBlock = true
        currentBlockId = genMatch[1] || '' // 提取ID，如果有的话
        blockContent = ''
        isGenerated = true
        continue
      }

      // 检查是否是AI修改的代码块开始
      const modMatch = AI_MODIFIED_RE.exec(line)
      if (modMatch) {
        inBlock = true
        currentBlockId = modMatch[2] || '' // 提取ID，如果有的话
        blockContent = ''
        isGenerated = false
        modifiedPercent = Number.parseInt(modMatch[1], 10)
        continue
      }
    }
    else if (AI_REGION_END.test(line)) {
      // 代码块结束
      inBlock = false
      blocks.push({
        id: currentBlockId,
        content: blockContent,
        isGenerated,
        modifiedPercent,
      })

      currentBlockId = ''
      blockContent = ''
      isGenerated = false
      modifiedPercent = undefined
    }
    else {
      // 累积代码块内容
      blockContent += `${line}\n`
    }
  }

  return blocks
}

// 处理文档，更新AI代码块状态
function processDocument(document: vscode.TextDocument) {
  const text = document.getText()
  const lines = text.split('\n')
  const filePath = document.uri.fsPath
  const blocksToUpdate: Array<{
    startLine: number
    endLine: number
    id: string
    content: string
    isGenerated: boolean
    modificationPercent: number
    previousModificationPercent: number
  }> = []

  // 确保快照存在
  if (!lastBlockSnapshots[filePath]) {
    lastBlockSnapshots[filePath] = {}
  }

  // 第一遍扫描：查找需要处理的代码块
  let inBlock = false
  let blockStartLine = -1
  let currentBlockId = ''
  let blockContent = ''
  let isGenerated = false
  let previousModificationPercent = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!inBlock) {
      // AI 生成的代码块
      const genMatch = AI_GENERATED_RE.exec(line)
      if (genMatch) {
        inBlock = true
        blockStartLine = i
        currentBlockId = genMatch[1] || ''
        blockContent = ''
        isGenerated = true
        previousModificationPercent = 0
        continue
      }

      // AI 修改的代码块
      const modMatch = AI_MODIFIED_RE.exec(line)
      if (modMatch) {
        inBlock = true
        blockStartLine = i
        currentBlockId = modMatch[2] || ''
        blockContent = ''
        isGenerated = false
        previousModificationPercent = Number.parseInt(modMatch[1], 10)
        continue
      }
    }
    else if (AI_REGION_END.test(line)) {
      // 代码块结束
      inBlock = false

      // 如果没有ID，生成一个
      if (!currentBlockId) {
        currentBlockId = generateShortId()
      }

      // 计算修改百分比
      let modificationPercent = 0

      if (lastBlockSnapshots[filePath][currentBlockId]) {
        const lastContent = lastBlockSnapshots[filePath][currentBlockId]
        const currentChangePercent = calculateModificationPercentage(lastContent, blockContent)

        if (isGenerated) {
          // 首次修改，直接使用计算的百分比
          modificationPercent = currentChangePercent
        }
        else {
          // 再次修改，使用累积公式
          modificationPercent = calculateCumulativeModification(
            previousModificationPercent,
            currentChangePercent,
          )
        }
      }

      // 添加到待更新列表
      blocksToUpdate.push({
        startLine: blockStartLine,
        endLine: i,
        id: currentBlockId,
        content: blockContent,
        isGenerated,
        modificationPercent,
        previousModificationPercent,
      })

      // 更新快照
      lastBlockSnapshots[filePath][currentBlockId] = blockContent

      // 重置变量
      currentBlockId = ''
      blockContent = ''
      isGenerated = false
      previousModificationPercent = 0
    }
    else {
      // 累积代码块内容
      blockContent += `${line}\n`
    }
  }

  // 没有需要处理的块，直接返回
  if (blocksToUpdate.length === 0) {
    return
  }

  // 应用更新
  const edit = new vscode.WorkspaceEdit()

  // 倒序处理以避免行号变化影响
  blocksToUpdate.sort((a, b) => b.startLine - a.startLine)

  for (const block of blocksToUpdate) {
    const { startLine, endLine, id, modificationPercent, isGenerated } = block

    // 根据修改百分比决定操作
    let action: 'none' | 'modify' | 'remove' | 'ensure_id' = 'none'

    if (isGenerated) {
      // AI 生成状态下的决策
      if (modificationPercent >= 70) {
        action = 'remove'
      }
      else if (modificationPercent >= 10) {
        action = 'modify'
      }
      else {
        // 确保有ID
        action = 'ensure_id'
      }
    }
    else {
      // AI 修改状态下的决策
      if (modificationPercent >= 70) {
        action = 'remove'
      }
      else if (modificationPercent > 0) {
        // 更新修改百分比
        action = 'modify'
      }
    }

    // 执行操作
    switch (action) {
      case 'remove':
        // 删除标记
        edit.delete(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
        )
        edit.delete(
          document.uri,
          new vscode.Range(endLine, 0, endLine + 1, 0),
        )

        // 从快照中删除
        delete lastBlockSnapshots[filePath][id]
        break

      case 'modify':
        // 更新为已修改状态
        edit.replace(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
          `// #region @ai_modified(${Math.round(modificationPercent)}%) id:${id}\n`,
        )
        break

      case 'ensure_id':
        // 仅确保有ID
        if (!lines[startLine].includes('id:')) {
          edit.replace(
            document.uri,
            new vscode.Range(startLine, 0, startLine + 1, 0),
            `// #region @ai_generated id:${id}\n`,
          )
        }
        break

      case 'none':
      default:
        // 不做任何操作
        break
    }
  }

  // 应用所有编辑
  vscode.workspace.applyEdit(edit).then((success) => {
    if (success && blocksToUpdate.length > 0) {
      // 编辑成功后自动保存文档
      document.save()
    }
  })
}

// 清理代码以进行比较
function cleanCodeForComparison(code: string): string {
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
  const cleanOriginal = cleanCodeForComparison(originalContent)
  const cleanCurrent = cleanCodeForComparison(currentContent)

  if (cleanOriginal === cleanCurrent) {
    return 0
  }

  // 如果原内容为空，默认100%修改
  if (!cleanOriginal) {
    return 100
  }

  const changes = diff.diffLines(cleanOriginal, cleanCurrent)
  let addedLines = 0
  let removedLines = 0
  let unchangedLines = 0

  for (const part of changes) {
    // 计算实际行数
    const lineCount = part.value.split('\n').length

    if (part.added) {
      addedLines += lineCount
    }
    else if (part.removed) {
      removedLines += lineCount
    }
    else {
      unchangedLines += lineCount
    }
  }

  const totalOriginalLines = unchangedLines + removedLines
  if (totalOriginalLines === 0) {
    return 100
  }

  // 计算修改百分比
  const changeRatio = (addedLines + removedLines) / (2 * totalOriginalLines)
  return Math.min(100, Math.max(0, Math.round(changeRatio * 100)))
}

// 累积修改百分比计算
function calculateCumulativeModification(previousPercent: number, currentChangePercent: number): number {
  // 有效修改部分：当前修改所影响的未修改部分
  const effectiveChange = (100 - previousPercent) * currentChangePercent / 100

  // 总体修改百分比
  return Math.min(100, Math.round(previousPercent + effectiveChange))
}

export function deactivate() {
  // 清理资源
  lastBlockSnapshots = {}
}
