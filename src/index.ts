import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import * as diff from 'diff'

// 定义正则表达式来检测带有ID的 AI 代码块
const AI_GENERATED_RE = /\/\/ #region @ai_generated(?:\s+id:([a-f0-9]{6}))?/
const AI_MODIFIED_RE = /\/\/ #region @ai_modified\((\d+%\))(?:\s+id:([a-f0-9]{6}))?/
const AI_REGION_END = /\/\/ #endregion/

// 状态栏项
let statusBarItem: vscode.StatusBarItem

// 存储上一次保存的代码块内容
interface BlockInfo {
  id: string
  content: string
  isGenerated: boolean
  modifiedPercent?: number
  startLine: number
  endLine: number
}

// 保存文件之前的代码块快照
let lastBlockSnapshots: { [filePath: string]: { [blockId: string]: string } } = {}

export function activate(context: vscode.ExtensionContext) {
  console.warn('AI Code Tracker activated')

  // 创建状态栏项
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'ai-code-tracker.generateReport'
  context.subscriptions.push(statusBarItem)

  // 注册命令: 生成项目统计报告
  const reportCommand = vscode.commands.registerCommand(
    'ai-code-tracker.generateReport',
    generateProjectReport,
  )
  context.subscriptions.push(reportCommand)

  // 注册文件保存事件
  const onSaveDocument = vscode.workspace.onDidSaveTextDocument((document) => {
    if (isSupportedFileType(document)) {
      processDocument(document)
      // 更新状态栏
      updateStatusBarInfo(document)
    }
  })

  // 注册文件打开事件
  const onOpenDocument = vscode.workspace.onDidOpenTextDocument((document) => {
    if (isSupportedFileType(document)) {
      // 初始化文件的代码块快照
      captureBlockSnapshots(document)
      // 更新状态栏
      updateStatusBarInfo(document)
    }
  })

  // 注册文档关闭事件以清理缓存
  const onCloseDocument = vscode.workspace.onDidCloseTextDocument((document) => {
    delete lastBlockSnapshots[document.uri.fsPath]
  })

  // 编辑器切换事件 - 更新状态栏
  const onActiveEditorChanged = vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateStatusBarInfo(editor?.document)
  })

  // 文档内容变更事件 - 更新状态栏（防抖动）
  let debounceTimer: NodeJS.Timeout | null = null
  const onTextDocumentChanged = vscode.workspace.onDidChangeTextDocument((event) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      updateStatusBarInfo(event.document)
      debounceTimer = null
    }, 500)
  })

  context.subscriptions.push(
    onSaveDocument,
    onOpenDocument,
    onCloseDocument,
    onActiveEditorChanged,
    onTextDocumentChanged,
  )

  // 初始化：处理当前已打开的文档
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document
    if (isSupportedFileType(document)) {
      captureBlockSnapshots(document)
      updateStatusBarInfo(document)
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
  // 使用栈来处理嵌套
  const blockStack: BlockInfo[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 检查是否是AI生成的代码块开始
    const genMatch = AI_GENERATED_RE.exec(line)
    const modMatch = AI_MODIFIED_RE.exec(line)

    if (genMatch || modMatch) {
      const isGenerated = !!genMatch
      const match = isGenerated ? genMatch! : modMatch!

      const newBlock: BlockInfo = {
        id: match[isGenerated ? 1 : 2] || '',
        content: '',
        isGenerated,
        modifiedPercent: isGenerated ? undefined : Number.parseInt(match[1], 10),
        startLine: i,
        endLine: -1,
      }

      blockStack.push(newBlock)
      continue
    }

    if (AI_REGION_END.test(line)) {
      if (blockStack.length === 0)
        continue // 忽略多余的结束标记

      const currentBlock = blockStack.pop()!
      currentBlock.endLine = i
      currentBlock.content = currentBlock.content.replace(/\n$/, '') // 移除最后一个换行

      if (!currentBlock.id) {
        currentBlock.id = generateShortId()
      }

      blocks.push(currentBlock)
    }
    else if (blockStack.length > 0) {
      // 只处理最内层的块内容
      const currentBlock = blockStack[blockStack.length - 1]
      currentBlock.content += `${line}\n`
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
    previousModificationPercent?: number
  }> = []

  // 确保快照存在
  if (!lastBlockSnapshots[filePath]) {
    lastBlockSnapshots[filePath] = {}
  }

  // 使用栈结构处理嵌套块
  const blockStack: Array<{
    startLine: number
    id: string
    isGenerated: boolean
    previousModificationPercent: number
    content: string
  }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 检查区域开始标记
    const genMatch = AI_GENERATED_RE.exec(line)
    const modMatch = AI_MODIFIED_RE.exec(line)

    if (genMatch || modMatch) {
      const isGenerated = !!genMatch
      const match = isGenerated ? genMatch! : modMatch!

      // 压入新块到栈中
      blockStack.push({
        startLine: i,
        id: match[isGenerated ? 1 : 2] || '',
        isGenerated,
        previousModificationPercent: isGenerated ? 0 : Number.parseInt(match[1], 10),
        content: '',
      })
      continue
    }

    // 检查区域结束标记
    if (AI_REGION_END.test(line)) {
      if (blockStack.length === 0)
        continue // 忽略无效结束标记

      // 弹出当前块
      const currentBlock = blockStack.pop()!

      // 生成ID（如果不存在）
      const finalId = currentBlock.id || generateShortId()

      // 计算修改百分比
      let modificationPercent = 0
      if (lastBlockSnapshots[filePath][finalId]) {
        const lastContent = lastBlockSnapshots[filePath][finalId]
        const currentChangePercent = calculateModificationPercentage(
          lastContent,
          currentBlock.content,
        )

        modificationPercent = currentBlock.isGenerated
          ? currentChangePercent // 生成块直接使用当前修改率
          : calculateCumulativeModification( // 修改块使用累积公式
            currentBlock.previousModificationPercent,
            currentChangePercent,
          )
      }

      // 记录需要更新的块
      blocksToUpdate.push({
        startLine: currentBlock.startLine,
        endLine: i,
        id: finalId,
        content: currentBlock.content,
        isGenerated: currentBlock.isGenerated,
        modificationPercent,
        previousModificationPercent: currentBlock.previousModificationPercent,
      })

      // 更新快照
      lastBlockSnapshots[filePath][finalId] = currentBlock.content
    }
    // 处理块内容（只处理最内层块）
    else if (blockStack.length > 0) {
      const currentBlock = blockStack[blockStack.length - 1]
      currentBlock.content += `${line}\n`
    }
  }

  // 没有需要处理的块则返回
  if (blocksToUpdate.length === 0)
    return

  // 应用编辑操作
  const edit = new vscode.WorkspaceEdit()

  // 倒序处理避免行号变化
  blocksToUpdate.sort((a, b) => b.startLine - a.startLine)

  for (const block of blocksToUpdate) {
    const { startLine, endLine, id, modificationPercent, isGenerated } = block

    // 保留原有缩进
    const leadingSpaces = lines[startLine].match(/^\s*/)?.[0] || ''

    // 决策逻辑
    const action = getActionType(isGenerated, modificationPercent)

    switch (action) {
      case 'remove':
        edit.delete(document.uri, new vscode.Range(startLine, 0, startLine + 1, 0))
        edit.delete(document.uri, new vscode.Range(endLine, 0, endLine + 1, 0))
        delete lastBlockSnapshots[filePath][id]
        break

      case 'modify':
        edit.replace(
          document.uri,
          new vscode.Range(startLine, 0, startLine + 1, 0),
          `${leadingSpaces}// #region @ai_modified(${Math.round(modificationPercent)}%) id:${id}\n`,
        )
        break

      case 'ensure_id':
        if (!lines[startLine].includes('id:')) {
          edit.replace(
            document.uri,
            new vscode.Range(startLine, 0, startLine + 1, 0),
            `${leadingSpaces}// #region @ai_generated id:${id}\n`,
          )
        }
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

// 辅助方法：决定操作类型
function getActionType(isGenerated: boolean, percent: number): 'remove' | 'modify' | 'ensure_id' | 'none' {
  if (isGenerated) {
    return percent >= 70
      ? 'remove'
      : percent >= 10
        ? 'modify'
        : 'ensure_id'
  }
  return percent >= 70
    ? 'remove'
    : percent > 0
      ? 'modify'
      : 'none'
}

// 累积修改百分比计算
function calculateCumulativeModification(previousPercent: number, currentChangePercent: number): number {
  // 有效修改部分：当前修改所影响的未修改部分
  const effectiveChange = (100 - previousPercent) * currentChangePercent / 100

  // 总体修改百分比
  return Math.min(100, Math.round(previousPercent + effectiveChange))
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

// 更新状态栏信息，显示当前文件中AI代码的统计
function updateStatusBarInfo(document: vscode.TextDocument | undefined): void {
  if (!document || !isSupportedFileType(document)) {
    statusBarItem.hide()
    return
  }

  const blocks = extractAllCodeBlocks(document.getText())

  if (blocks.length === 0) {
    statusBarItem.hide()
    return
  }

  // 计算统计信息
  const generatedCount = blocks.filter(b => b.isGenerated).length
  const modifiedCount = blocks.length - generatedCount

  // 计算AI代码所占行数
  const totalLines = document.lineCount
  let aiCodeLines = 0

  blocks.forEach((block) => {
    const blockLines = block.content.split('\n').length
    aiCodeLines += blockLines
  })

  const percentageOfFile = Math.round((aiCodeLines / totalLines) * 100)

  // 更新状态栏
  statusBarItem.text = `$(symbol-misc) AI: ${blocks.length} blocks (${percentageOfFile}% of file)`
  statusBarItem.tooltip
        = `AI Generated Code Statistics\n${generatedCount} generated, ${modifiedCount} modified\n${aiCodeLines} lines of ${totalLines} (${percentageOfFile}%)\nClick to view project report`
  statusBarItem.show()
}

// 生成项目级别AI代码统计报告
async function generateProjectReport(): Promise<void> {
  // 显示进度指示
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Generating AI code statistics report...',
    cancellable: false,
  }, async (progress) => {
    progress.report({ increment: 0 })

    // 查找项目中所有支持的文件
    const supportedFiles = await findSupportedFiles()
    const totalFiles = supportedFiles.length

    if (totalFiles === 0) {
      vscode.window.showInformationMessage('No supported files found in the workspace.')
      return
    }

    // 统计数据结构
    const stats = {
      date: new Date().toLocaleDateString(),
      totalFiles,
      filesWithAiCode: 0,
      totalAiBlocks: 0,
      generatedBlocks: 0,
      modifiedBlocks: 0,
      totalAiLines: 0,
      totalProjectLines: 0,
      averageModificationPercent: 0,
      blocksByLanguage: {} as { [key: string]: number },
      modificationDistribution: {
        '0-10%': 0,
        '11-30%': 0,
        '31-50%': 0,
        '51-70%': 0,
      },
      topFilesWithAiCode: [] as { file: string, blocks: number, aiLines: number, percentOfFile: number }[],
    }

    // 处理每个文件
    let filesProcessed = 0
    let totalModificationPercent = 0

    for (const fileUri of supportedFiles) {
      filesProcessed++

      if (filesProcessed % 10 === 0) {
        progress.report({
          increment: 10 * (100 / totalFiles),
          message: `Processed ${filesProcessed} of ${totalFiles} files`,
        })
      }

      try {
        const document = await vscode.workspace.openTextDocument(fileUri)
        const blocks = extractAllCodeBlocks(document.getText())

        // 文件行数
        const fileLines = document.lineCount
        stats.totalProjectLines += fileLines

        if (blocks.length > 0) {
          stats.filesWithAiCode++
          stats.totalAiBlocks += blocks.length

          // 统计该文件中AI代码行数
          let fileAiLines = 0

          // 统计语言分布
          const lang = document.languageId
          stats.blocksByLanguage[lang] = (stats.blocksByLanguage[lang] || 0) + blocks.length

          // 处理每个代码块
          for (const block of blocks) {
            const blockLines = block.content.split('\n').length
            fileAiLines += blockLines
            stats.totalAiLines += blockLines

            if (block.isGenerated) {
              stats.generatedBlocks++
            }
            else {
              stats.modifiedBlocks++

              // 累计修改百分比以计算平均值
              const modPercent = block.modifiedPercent || 0
              totalModificationPercent += modPercent

              // 统计修改分布
              if (modPercent <= 10) {
                stats.modificationDistribution['0-10%']++
              }
              else if (modPercent <= 30) {
                stats.modificationDistribution['11-30%']++
              }
              else if (modPercent <= 50) {
                stats.modificationDistribution['31-50%']++
              }
              else {
                stats.modificationDistribution['51-70%']++
              }
            }
          }

          // 添加到顶部文件列表
          stats.topFilesWithAiCode.push({
            file: path.basename(fileUri.fsPath),
            blocks: blocks.length,
            aiLines: fileAiLines,
            percentOfFile: Math.round((fileAiLines / fileLines) * 100),
          })
        }
      }
      catch (error) {
        console.error(`Error processing file ${fileUri.fsPath}:`, error)
      }
    }

    // 计算平均修改百分比
    if (stats.modifiedBlocks > 0) {
      stats.averageModificationPercent = Math.round(totalModificationPercent / stats.modifiedBlocks)
    }

    // 对顶部文件列表排序，仅保留前10个
    stats.topFilesWithAiCode.sort((a, b) => b.aiLines - a.aiLines)
    stats.topFilesWithAiCode = stats.topFilesWithAiCode.slice(0, 10)

    // 生成报告
    const reportContent = generateReportMarkdown(stats)

    // 在编辑器中显示
    const reportDoc = await vscode.workspace.openTextDocument({
      content: reportContent,
      language: 'markdown',
    })

    await vscode.window.showTextDocument(reportDoc)
  })
}

// 查找工作区中的所有支持文件
async function findSupportedFiles(): Promise<vscode.Uri[]> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return []
  }

  // 支持的文件类型
  const filePatterns = ['**/*.js', '**/*.ts', '**/*.vue']
  // 排除模式
  const excludePattern = '{node_modules,dist,build,.git,*.min.js}/**'

  let allFiles: vscode.Uri[] = []

  // 对每种文件类型进行查找
  for (const pattern of filePatterns) {
    const files = await vscode.workspace.findFiles(pattern, excludePattern)
    allFiles = [...allFiles, ...files]
  }

  return allFiles
}

// 生成Markdown格式的报告
function generateReportMarkdown(stats: any): string {
  // 计算AI代码渗透率
  const penetrationRate = stats.totalProjectLines > 0
    ? Math.round((stats.totalAiLines / stats.totalProjectLines) * 100)
    : 0

  let languageDistribution = ''
  if (Object.keys(stats.blocksByLanguage).length > 0) {
    languageDistribution = Object.entries(stats.blocksByLanguage)
      .map(([lang, count]) => `- **${lang}:** ${count} 个代码块 (${Math.round((Number(count) / stats.totalAiBlocks) * 100)}%)`)
      .join('\n')
  }
  else {
    languageDistribution = '- No language data available'
  }

  let topFilesTable = ''
  if (stats.topFilesWithAiCode.length > 0) {
    topFilesTable = '| 文件 | AI代码块 | AI代码行数 | 占文件比例 |\n|------|-----------|----------|----------|\n'
    topFilesTable += stats.topFilesWithAiCode
      .map((file: any) => `| ${file.file} | ${file.blocks} | ${file.aiLines} | ${file.percentOfFile}% |`)
      .join('\n')
  }
  else {
    topFilesTable = 'No files with AI code found.'
  }

  return `# AI代码统计报告
生成日期：${stats.date}

## 概要

- **分析的文件总数:** ${stats.totalFiles}
- **包含AI代码的文件:** ${stats.filesWithAiCode} (占项目${Math.round((stats.filesWithAiCode / stats.totalFiles) * 100)}%)
- **AI代码块总数:** ${stats.totalAiBlocks}
  - **生成的代码块:** ${stats.generatedBlocks}
  - **修改的代码块:** ${stats.modifiedBlocks}
- **AI代码行数:** ${stats.totalAiLines} / ${stats.totalProjectLines} (占项目${penetrationRate}%)
- **平均修改率:** ${stats.averageModificationPercent}%

## 语言分布

${languageDistribution}

## 修改分布

- **0-10%:** ${stats.modificationDistribution['0-10%']} 个代码块
- **11-30%:** ${stats.modificationDistribution['11-30%']} 个代码块
- **31-50%:** ${stats.modificationDistribution['31-50%']} 个代码块
- **51-70%:** ${stats.modificationDistribution['51-70%']} 个代码块

## AI代码最多的文件

${topFilesTable}

## 洞察

${stats.totalAiBlocks > 0
    ? `该项目包含 ${stats.totalAiBlocks} 个AI生成的代码块，总计 ${stats.totalAiLines} 行代码。AI代码约占项目代码库的 ${penetrationRate}%。`
    : `该项目中未检测到AI生成的代码块。`}

${stats.modifiedBlocks > 0
    ? `\n开发者已修改了 ${stats.modifiedBlocks} 个AI代码块，平均修改率为 ${stats.averageModificationPercent}%。这表明开发者积极与AI生成的代码进行交互和定制。`
    : ''
}

---
*Generated by AI Code Tracker extension*`
}

export function deactivate() {
  // 清理资源
  lastBlockSnapshots = {}
  statusBarItem.dispose()
}
