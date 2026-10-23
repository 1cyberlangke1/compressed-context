import type { Schema } from "effect"

import { isSessionDeleted } from "./deleted-sessions.ts"
import { parseState, stateKey, type State, type StorageLike } from "./state.ts"

/** 一次状态事务的结果；next 缺省表示只读，不写回。 */
export interface StateMutation<T> {
  readonly next?: State
  readonly result: T
}

/** 同一 storage 上的会话级状态存储。 */
export interface StateStore {
  /** 输入：sessionID；输出：当前状态快照。 */
  read(sessionID: string): Promise<State>
  /**
   * 输入：sessionID + 变更函数。
   * 输出：变更函数返回的 result。
   * 预期：同一 sessionID 的事务串行执行；事务内重新读取状态，不信任外部快照。
   */
  transact<T>(
    sessionID: string,
    mutate: (state: State) => StateMutation<T> | Promise<StateMutation<T>>,
  ): Promise<T>
}

/** 每个 storage 实例一份 store；测试替身之间互不干扰。 */
const stores = new WeakMap<StorageLike, StateStore>()

/**
 * 输入：storage。
 * 输出：该 storage 对应的 StateStore。
 * 预期：首次调用创建，之后复用；锁不会跨 storage 共享。
 */
export function stateStore(storage: StorageLike): StateStore {
  const existing = stores.get(storage)
  if (existing !== undefined) return existing
  const created = createStateStore(storage)
  stores.set(storage, created)
  return created
}

/**
 * 输入：storage。
 * 输出：新的 StateStore。
 * 预期：测试可直接创建独立实例；生产代码用 stateStore() 复用。
 */
export function createStateStore(storage: StorageLike): StateStore {
  /** 每个会话一条 Promise 链；链尾只表示前一个事务已结束，不传递结果。 */
  const tails = new Map<string, Promise<void>>()

  const read = async (sessionID: string): Promise<State> =>
    parseState(await storage.get(stateKey(sessionID)))

  const transact = async <T>(
    sessionID: string,
    mutate: (state: State) => StateMutation<T> | Promise<StateMutation<T>>,
  ): Promise<T> => {
    const previous = tails.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // previous 理论上永不 reject；仍兜一层，避免坏事务把后续请求永久卡住。
    const tail = previous.then(() => gate, () => gate)
    tails.set(sessionID, tail)
    await previous.catch(() => undefined)
    try {
      const state = await read(sessionID)
      const mutation = await mutate(state)
      if (mutation.next !== undefined && !isSessionDeleted(sessionID)) {
        await storage.set(stateKey(sessionID), mutation.next as unknown as Schema.Json)
      }
      return mutation.result
    } finally {
      release()
      if (tails.get(sessionID) === tail) tails.delete(sessionID)
    }
  }

  return { read, transact }
}
