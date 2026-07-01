import type {
  Script,
  Block,
  Reporter,
  BooleanInput,
  AnyInput,
  SubstackInput,
  CompiledFunctionWithDefault
} from '@scratch-fuse/compiler'
import type { Parameter, FunctionDeclaration } from '@scratch-fuse/core'
import { parseProccodeArgumentTypes } from '@scratch-fuse/utility'
import { Sb3Workspace, Sb3Block, Sb3Input, Sb3CommentMap } from './base'

/**
 * 反序列化上下文，用于跟踪已处理的积木
 */
interface DeserializationContext {
  workspace: Sb3Workspace
  processedBlocks: Set<string> // 已处理的积木 ID
}

/**
 * 创建反序列化上下文
 */
function createContext(workspace: Sb3Workspace): DeserializationContext {
  return {
    workspace,
    processedBlocks: new Set()
  }
}

/**
 * 将 Sb3Input 转换回输入值
 */
function deserializeInput(
  key: string,
  input: Sb3Input,
  context: DeserializationContext,
  comments?: Sb3CommentMap
): BooleanInput | AnyInput | SubstackInput | null {
  if (Array.isArray(input)) {
    const [type, ...rest] = input

    if (type === 1) {
      // [1, Sb3ShadowInput] 或 [1, string]
      const value = rest[0]
      if (!value) return null
      if (typeof value === 'string') {
        // [1, string] - any reporter without shadow
        const reporter = deserializeReporter(value, context)
        return { type: 'any', value: reporter }
      } else if (rest[0][0] === 12) {
        // [1, Sb3VariableInput] - variable reporter without shadow
        return {
          type: 'any',
          value: {
            opcode: 'data_variable',
            fields: {
              VARIABLE: rest[0][1]
            },
            inputs: {}
          }
        }
      } else {
        // [1, Sb3ShadowInput] - literal value
        return { type: 'any', value: rest[0][1] }
      }
    } else if (type === 2) {
      // [2, string] - boolean reporter or substack
      const blockId = rest[0]
      if (!blockId) return null
      if (typeof blockId !== 'string') {
        if (blockId[0] === 12) {
          return {
            type: 'any',
            value: {
              opcode: 'data_variable',
              fields: {
                VARIABLE: blockId[1]
              },
              inputs: {}
            }
          }
        } else {
          return { type: 'any', value: blockId[1] }
        }
      }
      const block = context.workspace[blockId]

      if (!block) {
        throw new Error(`Block not found: ${blockId}`)
      }

      // 判断是 substack 还是 boolean reporter
      // 如果积木有 parent 且 parent 不是当前输入的父积木，则是 boolean reporter
      // 否则检查是否是堆叠式积木（有 next 连接）
      const isSubstack = block.next !== null || key.startsWith('SUBSTACK')

      if (isSubstack) {
        // substack
        const blocks = deserializeBlockChain(blockId, context, comments)
        return { type: 'substack', value: blocks }
      } else {
        // boolean reporter
        const reporter = deserializeReporter(blockId, context)
        return { type: 'bool', value: reporter }
      }
    } else if (type === 3) {
      // [3, string, Sb3ShadowInput] - any reporter with shadow
      // or [3, Sb3VariableInput, Sb3ShadowInput] - variable reporter with shadow
      const block = rest[0]
      if (!block) return null
      if (typeof block === 'string') {
        const reporter = deserializeReporter(block, context)
        return { type: 'any', value: reporter }
      } else if (block[0] === 12) {
        return {
          type: 'any',
          value: {
            opcode: 'data_variable',
            fields: {
              VARIABLE: block[1]
            },
            inputs: {}
          }
        }
      } else {
        return { type: 'any', value: block[1] }
      }
    }
  }

  throw new Error(`Unsupported input format: ${JSON.stringify(input)}`)
}

/**
 * 将 Sb3Block 转换回 Reporter
 */
function deserializeReporter(
  blockId: string,
  context: DeserializationContext
): Reporter {
  const sb3Block = context.workspace[blockId]
  if (!sb3Block) {
    throw new Error(`Block not found: ${blockId}`)
  }

  const reporter: Reporter = {
    opcode: sb3Block.opcode,
    inputs: {},
    fields: {}
  }

  // 处理 inputs
  for (const [key, value] of Object.entries(sb3Block.inputs)) {
    const result = deserializeInput(key, value, context)
    if (result) reporter.inputs[key] = result
  }

  // 处理 fields
  for (const [key, value] of Object.entries(sb3Block.fields)) {
    reporter.fields[key] = value[0]
  }

  // 处理 mutation
  if (sb3Block.mutation) {
    reporter.mutation = sb3Block.mutation
  }

  return reporter
}

/**
 * 将 Sb3Block 转换回 Block
 */
function deserializeBlock(
  blockId: string,
  context: DeserializationContext,
  comments?: Sb3CommentMap
): Block {
  const sb3Block = context.workspace[blockId]
  if (!sb3Block) {
    throw new Error(`Block not found: ${blockId}`)
  }

  context.processedBlocks.add(blockId)

  const block: Block = {
    opcode: sb3Block.opcode,
    inputs: {},
    fields: {}
  }

  // 处理 inputs
  for (const [key, value] of Object.entries(sb3Block.inputs)) {
    const result = deserializeInput(key, value, context, comments)
    if (result) block.inputs[key] = result
  }

  // 处理 fields
  for (const [key, value] of Object.entries(sb3Block.fields)) {
    block.fields[key] = value[0]
  }

  // 处理 mutation
  if (sb3Block.mutation) {
    block.mutation = sb3Block.mutation
  }

  // 附加注释（加回 // 前缀以匹配 FUSE 语法）
  if (comments) {
    for (const comment of Object.values(comments)) {
      if (comment.blockId === blockId) {
        const text = comment.text.startsWith('//') ? comment.text : `// ${comment.text}`
        block.comment = text
        break
      }
    }
  }

  return block
}

/**
 * 反序列化积木链（从指定积木开始，沿着 next 链接）
 */
function deserializeBlockChain(
  startBlockId: string,
  context: DeserializationContext,
  comments?: Sb3CommentMap
): Block[] {
  const blocks: Block[] = []
  let currentId: string | null = startBlockId

  while (currentId !== null) {
    if (context.processedBlocks.has(currentId)) {
      break
    }

    const sb3Block: Sb3Block | undefined = context.workspace[currentId]
    if (!sb3Block) {
      throw new Error(`Block not found: ${currentId}`)
    }

    const block = deserializeBlock(currentId, context, comments)
    blocks.push(block)

    currentId = sb3Block.next
  }

  return blocks
}

/**
 * 反序列化帽子积木
 */
function deserializeHat(
  blockId: string,
  context: DeserializationContext,
  comments?: Sb3CommentMap
): Block {
  const sb3Block = context.workspace[blockId]
  if (!sb3Block) {
    throw new Error(`Block not found: ${blockId}`)
  }

  context.processedBlocks.add(blockId)

  const hat: Block = {
    opcode: sb3Block.opcode,
    inputs: {},
    fields: {}
  }

  // 处理 inputs
  for (const [key, value] of Object.entries(sb3Block.inputs)) {
    const result = deserializeInput(key, value, context, comments)
    if (result) hat.inputs[key] = result
  }

  // 处理 fields
  for (const [key, value] of Object.entries(sb3Block.fields)) {
    hat.fields[key] = value[0]
  }

  // 处理 mutation
  if (sb3Block.mutation) {
    hat.mutation = sb3Block.mutation
  }

  // 附加注释
  if (comments) {
    for (const comment of Object.values(comments)) {
      if (comment.blockId === blockId) {
        hat.comment = comment.text
        break
      }
    }
  }

  return hat
}

/**
 * 从 Sb3Workspace 反序列化为 Block 数组
 */
export function deserializeBlocks(workspace: Sb3Workspace): Block[] {
  const context = createContext(workspace)

  // 找到顶层积木（topLevel === true 且 parent === null）
  const topLevelBlocks = Object.entries(workspace)
    .filter(([_, block]) => block.topLevel && block.parent === null)
    .map(([id]) => id)

  if (topLevelBlocks.length === 0) {
    return []
  }

  // 反序列化第一个顶层积木链
  const firstTopLevelId = topLevelBlocks[0]
  return deserializeBlockChain(firstTopLevelId, context)
}

/**
 * 从 Sb3Workspace 反序列化为 Script
 */
export function deserializeScript(workspace: Sb3Workspace, comments?: Sb3CommentMap): Script {
  const context = createContext(workspace)

  // 找到顶层积木
  const topLevelEntries = Object.entries(workspace).filter(
    ([_, block]) => block.topLevel && block.parent === null
  )

  if (topLevelEntries.length === 0) {
    return { blocks: [] }
  }

  const [topLevelId, topLevelBlock] = topLevelEntries[0]

  // 检查是否是帽子积木
  const isHatBlock = topLevelBlock.opcode.startsWith('event_')

  if (isHatBlock) {
    // 有帽子积木
    const hat = deserializeHat(topLevelId, context, comments)
    const nextId = topLevelBlock.next

    if (nextId) {
      // 有后续积木
      const blocks = deserializeBlockChain(nextId, context, comments)
      return { hat, blocks }
    } else {
      // 只有帽子积木
      return { hat, blocks: [] }
    }
  } else {
    // 没有帽子积木，直接是普通积木
    const blocks = deserializeBlockChain(topLevelId, context, comments)
    return { blocks }
  }
}

/**
 * 从 Sb3Workspace 反序列化为 CompiledFunction
 */
export function deserializeFunction(
  workspace: Sb3Workspace,
  comments?: Sb3CommentMap
): CompiledFunctionWithDefault {
  const context = createContext(workspace)

  // 找到 procedures_definition 积木
  const definitionEntry = Object.entries(workspace).find(
    ([_, block]) => block.opcode === 'procedures_definition'
  )

  if (!definitionEntry) {
    throw new Error('No procedures_definition block found')
  }

  const [definitionId, definitionBlock] = definitionEntry

  // 获取 custom_block 输入（原型积木）
  const customBlockInput = definitionBlock.inputs.custom_block
  if (!customBlockInput || !Array.isArray(customBlockInput)) {
    throw new Error('Invalid custom_block input')
  }

  const prototypeId =
    customBlockInput[0] === 1
      ? (customBlockInput[1] as string)
      : (customBlockInput[1] as string)
  const prototypeBlock = context.workspace[prototypeId]

  if (!prototypeBlock || prototypeBlock.opcode !== 'procedures_prototype') {
    throw new Error('Invalid procedures_prototype block')
  }

  // 解析 mutation 信息
  const mutation = prototypeBlock.mutation
  if (!mutation) {
    throw new Error('No mutation found in procedures_prototype')
  }

  const proccode = mutation.proccode as string
  const argumentnames = JSON.parse(mutation.argumentnames as string) as string[]
  const argumentdefaults = JSON.parse(
    mutation.argumentdefaults as string
  ) as string[]
  const argumentTypes = parseProccodeArgumentTypes(proccode)
  const warp = mutation.warp === 'true'

  // 构建参数列表
  const parameters: Parameter[] = argumentnames.map((name, index) => {
    const type = argumentTypes[index] || 'any'

    return {
      name: { name },
      type: { name: type }
    } as Parameter
  })

  // 构建函数声明
  const decl: FunctionDeclaration = {
    name: { name: '' },
    parameters,
    once: warp,
    returnType: { name: '' }
  } as FunctionDeclaration

  // 反序列化函数体
  const nextId = definitionBlock.next
  const impl = nextId ? deserializeBlockChain(nextId, context, comments) : []

  return {
    decl,
    proccode,
    impl,
    defaultValues: argumentdefaults
  }
}

/**
 * 从 Sb3Workspace 反序列化所有顶层脚本
 */
export function deserializeAllScripts(workspace: Sb3Workspace, comments?: Sb3CommentMap): Script[] {
  const context = createContext(workspace)

  // 找到所有顶层积木
  const topLevelIds = Object.entries(workspace)
    .filter(([_, block]) => block.topLevel && block.parent === null)
    .map(([id]) => id)

  const scripts: Script[] = []

  for (const topLevelId of topLevelIds) {
    if (context.processedBlocks.has(topLevelId)) {
      continue
    }

    const topLevelBlock = workspace[topLevelId]

    // 检查是否是函数定义积木
    if (topLevelBlock.opcode === 'procedures_definition') {
      continue // 跳过函数定义，因为它们需要特殊处理
    }

    // 检查是否是帽子积木
    // const isHatBlock = topLevelBlock.opcode.startsWith('event_')

    // if (isHatBlock) {
    const hat = deserializeHat(topLevelId, context, comments)
    const nextId = topLevelBlock.next
    const blocks = nextId ? deserializeBlockChain(nextId, context, comments) : []
    scripts.push({ hat, blocks })
    // } else {
    //   const blocks = deserializeBlockChain(topLevelId, context)
    //   scripts.push({ blocks })
    // }
  }

  return scripts
}

/**
 * 从 Sb3Workspace 反序列化所有函数
 */
export function deserializeAllFunctions(
  workspace: Sb3Workspace,
  comments?: Sb3CommentMap
): CompiledFunctionWithDefault[] {
  const functions: CompiledFunctionWithDefault[] = []

  // 找到所有 procedures_definition 积木
  const definitionIds = Object.entries(workspace)
    .filter(([_, block]) => block.opcode === 'procedures_definition')
    .map(([id]) => id)

  for (const definitionId of definitionIds) {
    // 创建临时 workspace，只包含与此函数相关的积木
    const functionWorkspace: Sb3Workspace = {}

    // 收集函数相关的所有积木
    const collectFunctionBlocks = (blockId: string) => {
      if (functionWorkspace[blockId]) {
        return
      }

      const block = workspace[blockId]
      if (!block) {
        return
      }

      functionWorkspace[blockId] = block

      // 递归收集相关积木
      if (block.next) {
        collectFunctionBlocks(block.next)
      }

      for (const input of Object.values(block.inputs)) {
        if (Array.isArray(input)) {
          if (typeof input[1] === 'string') {
            collectFunctionBlocks(input[1])
          }
        }
      }
    }

    collectFunctionBlocks(definitionId)

    // 过滤出属于此函数的注释
    const functionComments: Sb3CommentMap = {}
    if (comments) {
      for (const [commentId, comment] of Object.entries(comments)) {
        if (comment.blockId && functionWorkspace[comment.blockId]) {
          functionComments[commentId] = comment
        }
      }
    }

    const func = deserializeFunction(functionWorkspace, functionComments)
    functions.push(func)
  }

  return functions
}
