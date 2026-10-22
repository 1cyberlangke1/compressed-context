# 基准测试

> **这不是一份严谨的评测报告。**
>
> 每组只跑了一次，样本量为 1；模型采样、网络抖动、容器启动时间都会影响结果，
> 同一配置重跑出现几十分钟的时长差、甚至成功/失败翻转都很正常。
> 下面的数字只能用来判断「压缩到底有没有把上下文压下去」，不能用来给插件排名。

## 测试条件

| 项 | 值 |
|---|---|
| 任务 | Terminal-Bench 2.1 · `schemelike-metacircular-eval` |
| 任务内容 | 用 Scheme 写一个能解释自身和 `interp.py` 语言的元循环求值器，63 个用例判定 |
| 模型 | `gemini-3.8-flash-high`（reasoning = high） |
| agent 超时 | 2400 秒（任务自带，不可调） |
| 运行器 | Harbor + Docker |
| 组数 | 每组 1 次 |

## 结果

数字全部来自 agent 轨迹里每条 `step_finish` 的 `tokens` 汇总：
**总输入 = Σ(input + cache.read)**，**缓存 = Σ cache.read**，单步峰值同理。

| 组 | 窗口 | 插件 | reward | 时长 | 总输入 | 缓存 | 缓存占比 | 输出 | 单步峰值 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| native | 200k | 无 | **1.0** | 35m18s | 7,136,447 | 6,999,101 | 98.1% | 16,441 | 146,123 |
| compressed | 100k | compressed-context | **1.0** | 41m04s（超时） | 5,935,881 | 5,660,871 | 95.4% | 21,325 | **93,560** |
| billion | 100k | billion-context | 0.0 | 40m07s（超时） | 6,874,707 | 6,607,407 | 96.1% | 15,520 | 58,955 |

关键补充：

- **compressed 也是超时**。它在 2400 秒被杀，但 `eval.scm` 在超时前已经写好，所以 verifier 照常跑并判定通过；native 是 35m18s 正常结束。
- compressed 压缩了 3 次（`blocks = [T1, T1, T1]`），单步峰值 93,560，**没有越过 100k 窗口**。
- billion 单步峰值最低（58,955），压得比 compressed 更狠，但 40 分钟里一直在用 `python3` 探测 `interp.py` 语义（79 次探针），始终没写出 `/app/eval.scm`，verifier 判 0。
- native 在 200k 窗口下单步峰值 146,123，属于正常水位。

## 单步上下文曲线

### native 200k

![native 200k](charts/native-200k.png)

### compressed 100k

![compressed 100k](charts/compressed-100k.png)

缓存命中量一路上涨，到压缩点垂直掉回底部，一共 3 次，正好对应 `blocks = [T1, T1, T1]`。

### billion 100k

![billion 100k](charts/billion-100k.png)

## 已知局限

1. **n = 1**。compressed 和 billion 都贴着 2400 秒上限，成功与失败只差几分钟余量，重跑可能翻转。
2. **任务本身偏难**。三组都把时间跑满，说明这个任务对该模型处于能力边缘，
   测到的是「能不能刚好写完」，不是「压缩质量」。
3. **网络与验证器**。验证器需要联网装依赖，网络抖动会直接导致 0 分，与插件无关。
4. **缓存口径**。不同 provider 对缓存 token 的计费方式不同，跨 provider 不可比。

## 结论

在 100k 窗口下，compressed-context 把单步上下文稳定压在窗口内（峰值 93,560）并让这次运行通过验证；
billion-context 在同条件下没有完成产物。这只能说明「这次跑通了」，
不足以说明哪个策略更好——要下结论需要多次重复取中位数。
