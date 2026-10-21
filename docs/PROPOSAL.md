# agent-skill 可信技能运行时方案

## 1. 背景：分发已解决，信任没有

Agent 技能生态在很短的时间里完成了第一阶段：格式趋于统一（`SKILL.md`）、分发方式出现（skillpm 与 npm 风格的包管理）、发现与评分出现（Skilldex 等注册表）。这些工作解决的是「技能怎么到达用户机器」。它们没有回答另一个问题：技能到达之后，用户凭什么相信它。

现有方案基本停在安装时的元数据层。`skill.yaml` 或 frontmatter 里的 `capabilities`、`allowed-tools` 是声明，不是事实；声明可能撒谎，也可能过时。注册表给的评分通常基于格式完整度与作者自述，仍然不是运行证据。把信任写进元数据之后，运行时并不会因此多出任何限制。

更麻烦的是声明与行为之间的漂移。一个技能可以在清单里只写 `fs.read`，脚本却在运行时读取环境变量、拼出外网地址；也可以声明 `allowed-tools: Read`，却在正文里诱导模型调用 Bash。静态检查不能证明技能安全，但能在进入宿主之前把明显越界的声明与脚本挑出来，并把判定结果固定成可复核的编码。这是本项目选择「准入优先」而不是「运行时万能」的原因。

真正的危险时刻比「工具调用」更早。宿主解析 `SKILL.md` 时，可能先执行 `!`command`` 预处理，再把内容交给模型。Mint Security 的 PoC 表明，凭据可以在模型看到第一个 token 之前被外泄。等模型读到技能内容再做判断，已经晚了：那是取证，不是预防。

这个时间差决定了执法点的位置。能覆盖预处理的只有两处：安装或 CI 阶段的准入（`verify`），以及自建的 standalone 加载器。宿主侧的 hooks 适配器做不到，因为 hook 在技能加载之后才触发。把这一点写进文档不是自我限制，而是避免给出无法兑现的承诺。适配器仍有价值：它能覆盖加载之后的每一次工具调用，并把观测写进同一条 trace。

因此本项目把能力分成三段：安装前准入、加载与运行时的权限上限、跑完之后的证据链。沙箱只在 standalone 模式兜底，用于降低试跑风险，不作为卖点，也不声称是内核级隔离。与 Claude Code 原生沙箱相比，本方案的隔离强度更低；拿沙箱当卖点会被一句话比下去，方案的价值必须落在时点与证据上。

设计上只保留四条主线：固定的 finding 编码、固定的失败映射、由信任等级决定的权限上限、可哈希核对的证据卡。其余部分尽量小：三个运行时依赖、本地可跑、不接外部服务、不重建包管理与注册表。这样做的代价是功能面窄，好处是每条承诺都能被测试或命令行复现。

外发表达固定为三句话，README 首屏、本方案第一章末段与 CLI `--help` 首行都原文引用，不改写成「安全、可靠、可扩展」这类不可验证的形容词：

1. 别人管「装」，我们管「装之前和跑之后」。
2. 别人告诉你技能声明了什么，我们给出它实际做了什么的证据。
3. 别人把信任写在元数据里，我们让信任等级直接决定运行时权限上限。

## 2. 目标与非目标

P0–P2 的目标是给出一条可复现的最小闭环：

- 在技能目录被复制进宿主之前，拒绝预处理命令、越权 `allowed-tools`、未登记脚本、路径穿越与未声明外联。
- 解析双文件清单，保留 `SKILL.md` 原文用于扫描，把运行时元数据放进 `skill.yaml`。
- 提供五段过滤链、信任等级上限、固定失败映射与 JSONL trace。
- 提供 eval runner、五项指标、证据卡与 `evidence.lock`。
- 提供 Claude hooks-only 适配器，并在输出里写清它覆盖不到预处理。
- 提供示例技能、对抗样本、单元与集成测试，CI 在 Ubuntu 与 Windows 上可复现。

非目标同样明确：多租户隔离、分布式执行、可视化 UI、模型路由与成本优化、长会话记忆治理、自建包管理与注册表、内核级沙箱、签名基础设施与中心化注册表。这些方向并非没有价值，而是与本项目要验证的核心假设无关；把它们塞进 P0–P2 只会稀释验收标准。

还有一条隐性目标：不改变技能作者的工作流。作者仍然写 `SKILL.md`，只需要补一个 `skill.yaml`；不要求改代码、不要求接 SDK、不要求上传到中心服务。接入成本越低，准入才越可能被真正使用。

验收以可观察行为为准，不以文档声明为准：合法示例 `verify --gate install` 退出码为 0；对抗样本被拒绝且 findings 含 `preprocessing-command`；过滤链顺序快照通过；trace 覆盖全部事件类型；`eval --k 5` 输出五项指标与置信区间；证据卡重复生成哈希稳定；T1 技能执行脚本报权限错误；适配器在 mock 上完成加载后准入与观测。

## 3. 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node `>=22.23.2` | 低版本受 CVE-2026-58043 影响，必须锁定 |
| 语言 | TypeScript 7.0.2，ESM | 原生编译器；只做类型检查与转译，不引 bundler |
| 包管理 | npm，单包 `agent-skill` | 包名已确认可用，避免 workspace 复杂度 |
| 运行时依赖 | `yaml` 2.9、`semver` 7.8、`zod` 4.6 | 安全工具，依赖越少越好 |
| CLI 解析 | `node:util.parseArgs` | 不引 commander，减少供应链面 |
| 测试 | vitest 5.0.5 | 与 Vite 8 兼容，快照与 mock 够用 |
| 许可 | Apache-2.0 | 专利授权，利于企业采用 |

选择 Node 22.23.2 是硬约束，不是偏好。Node 的权限模型提供 `--permission`、`--allow-fs-read`、`--allow-fs-write`，足以在 standalone 模式限制路径与写权限；但该模型历史上出过 CVE，且预加载守卫可以被原生扩展绕过。因此版本锁定与「非安全边界」的表述必须同时存在，缺一不可。

TypeScript 使用 `NodeNext`、`strict`、`verbatimModuleSyntax`，源码直接以 `.js` 后缀导入，`tsc` 只输出 `dist`，不引入打包器。这样做的原因是调试与审计都更直接：用户看到的 `dist` 与 `src` 一一对应，trace 里的文件路径不会经过 sourcemap 变形。类型检查在 CI 中独立执行，避免「能跑但类型漂移」。

测试策略跟着不变量走：schema 边界用表驱动，过滤链用顺序快照，执行器用注入的 sleep 验证退避，沙箱用临时目录验证读写边界，证据卡用固定输入验证哈希稳定。对抗样本只包含可检测模式，不放可用利用代码，避免测试仓库本身成为攻击工具。

依赖控制在三个运行时包。`yaml` 负责 frontmatter 与 `skill.yaml`，`semver` 负责版本与范围校验，`zod` 负责 schema 与默认值。CLI 用 `parseArgs`，测试用 vitest，没有 ORM、没有 HTTP 框架、没有遥测 SDK。少一个依赖，就少一个需要解释的权限与漏洞面。

跨平台是硬要求。路径解析统一使用 `node:path`，测试在 Windows 与 Linux 上都要通过；CI 矩阵覆盖 ubuntu 与 windows。副作用是部分错误信息会带平台分隔符，因此断言只匹配稳定片段，不匹配完整路径。时间、随机数与输出流都通过参数注入，测试不依赖真实时钟。

不采用 Spring AI，也不引入 Java 栈。我们只借它的 Advisor 链语义：有序、可短路、可回卷。实现保持在 TypeScript 内，才能与 Agent 宿主的 Node 生态同栈部署。这个取舍牺牲了与企业 Java 平台的直接集成，换来了安装体积与启动延迟。

## 4. 功能范围

### P0（0.1.0）：准入、注册表、过滤链、trace

清单层解析 `SKILL.md` 与 `skill.yaml`。frontmatter 只允许 `name`、`description`，原文完整保留供扫描；`skill.yaml` 承载版本、能力、依赖、冲突、权限、信任等级与评测目录。`allowed-tools` 被单独解析，脚本清单由目录扫描得出，二者与 `permissions.exec` 做交叉核对。

准入最小集由 G1 与 G2 组成。G1 做静态扫描：预处理命令、越权工具、未登记脚本、路径穿越与可疑外联。G2 做规则检查，输出 finding 或 advisory；它不接模型，避免把裁决权交给一个不可复现的组件。finding 编码固定为六个，CI 与文档只引用这六个，不临时发明新词。

注册表支持四种作用域：singleton、session、task、repo，优先级为 task > session > repo > singleton。注册时做严格校验：同名同作用域重复注册视为冲突，版本必须是合法 semver，依赖闭包检测缺失、冲突与环。运行时按优先级解析，避免「装了哪个版本」靠猜。

过滤链固定五段：限流、身份、capability、DLP、审计。`before` 按 order 升序执行，`after` 逆序回卷；任何短路都必须留下事件。策略错误一律 fail-closed；只读操作上的非策略错误可以 fail-open 并记录降级事件；变更与不可逆操作 fail-closed。执行器负责把下游异常映射为固定失败类别，而不是让过滤器把异常吞成策略拒绝。

trace 以 JSONL 追加写入，事件类型固定。运行、准入、生命周期、工具调用、执行重试、沙箱、监督器、评测、证据与适配器各有独立事件，任何执行先产出事件再返回结果。

CLI 提供 `init`、`verify`（含 `--gate install`）、`inspect`、`run`。示例技能 `invoice-reconcile` 读取 JSON 发票并输出对账结果；对抗样本演示「复制进技能目录之前被拒绝」。

`verify` 在拒绝时输出每条 finding 的编码、位置与证据摘要，退出码为 2；`inspect` 输出信任等级、权限上限与清单问题，便于在接入前发现声明错误；`run` 只执行 `permissions.exec` 中列出的命令，未声明即拒绝。退出码固定为 0/1/2/3/4，CI 可以直接按码分流，不需要解析文本。

### P1（0.2.0）：生命周期、评测、证据

生命周期状态机为 admitted → loaded → active → disposed，非法迁移直接报错。钩子在迁移前后触发，`SkillPostProcessor` 按 order 排序执行，输入输出显式传递，不依赖模块级单例。

评测 runner 支持 `--k` 次重复。grader 分三档：L0 精确匹配，L1 字段级匹配（示例技能用它比对 `status`、`outstanding`、`error`、`decision`），L2 判官接口默认 mock，不把外部模型变成测试前提。指标包括 `pass@1` 与 Wilson 95% 置信区间、`pass^k`、`cost_per_success`、`p95_latency`、`escalation_rate`。失败用例同样进入证据，不能只统计成功样本。

证据卡固定字段：技能、版本、完整性哈希、数据来源、样本数、五项指标、已知失败、G1–G4 结果、信任等级、模型矩阵、harness 版本与生成时间。`data_source` 在 P0–P2 恒为 `synthetic`。证据文件按稳定序列化计算 sha256，写入 `evidence.lock`；任何字段变动都会导致校验失败。

评测的确定性优先于覆盖率。示例用例的输入、输出与 grader 都固定，`--now` 可注入生成时间，证据卡的字段顺序与序列化方式固定，因此在固定 `--now` 后重复运行得到相同的哈希。需要外部模型的 L2 判官默认 mock，只有显式注入时才启用，避免 CI 因网络或模型版本波动而红。

CLI 增加 `eval`。README 与方案首屏按三条优势句定稿，对比表放在架构之后。

### P2（0.3.0）：准入补全、沙箱、监督器、适配器

G3 在临时副本中试运行已声明命令，只支持 `node` 命令；非 node 命令给出 advisory 并跳过。试跑检测到外联时记 `network-egress`，命令失败记 `dependency-risk`。临时目录在结束后删除，不污染原技能目录。

G4 把声明权限与信任等级上限对齐：T1/T2 声明 exec 直接失败，T1/T2 声明 net 失败，非 T4 声明 secrets 失败，路径穿越失败，执行项引用不存在的脚本记 `unlisted-script`。上限不是建议，运行时执行器会再检查一次。

G3 与 G4 的顺序有讲究：先试跑再核对权限，可以在临时副本里观察真实行为，再把观察结果与声明对齐。试跑只支持 `node` 命令，是因为跨平台的进程控制与权限模型只在 Node 上可复现；其他命令给 advisory 而不是假装检查过。这个限制写在输出里，不藏在代码注释里。

进程沙箱作为 standalone 兜底：`node --permission` 限制读写路径，环境变量走白名单，网络与子进程由预加载守卫拦截，资源上限为 30 秒、256MB 堆、1MB 输出、50 个文件、10MB 写入。网络守卫通过 `fetch`、`http`、`https`、`net`、`dns` 与子进程路径拦截并记录 `sandbox.egress-blocked`。它仍然不是安全边界。

监督器实现重启策略与强度上限：默认 60 秒窗口内最多 3 次重启，超过即抛错并记录 `supervisor.restart` 的 exhausted 事件。退避为指数增长，测试中用注入的 sleep 与 clock 保证确定性。

Claude 适配器是 hooks-only：`PreToolUse` 做准入，`PostToolUse` 做观测，输出同时写入 trace。适配器无法阻止宿主预处理，这句话既在 `ADAPTER_LIMITATION` 常量里，也在 `adapter claude` 的 JSON 输出里。

CLI 的 `adapter claude` 有两种模式：默认打印 hooks 配置，包含 PreToolUse 与 PostToolUse 两条命令；`--hook` 模式读取一条 JSON 载荷，返回 `continue` 与 `permissionDecision`，供宿主直接消费。两种模式共用同一套过滤器与 trace，避免「配置里是一套、执行时是另一套」。

## 5. 系统架构

三个执法点覆盖技能生命周期的三个不同时刻：

```
安装前 / CI            加载时                  工具调用时
verify + G1/G2   →   standalone runtime   →   adapter hooks
唯一能覆盖           过滤链 + 沙箱兜底          PreToolUse 准入
!`command`                                        PostToolUse 观测

CLI (src/cli)
 ├─ init / verify / inspect
 ├─ eval   ─→ Eval Runner ─→ Evidence Card + Evidence Lock
 ├─ run    ─→ Registry ─→ Lifecycle ─→ Filter Chain ─→ Executor ─→ Trace
 │                            └─ SkillPostProcessor
 └─ adapter claude ─→ PreToolUse / PostToolUse
```

模块边界与目录一一对应：`manifest` 只做解析与校验，`admission` 只做判定，`registry` 与 `lifecycle` 管状态，`filters` 与 `runtime` 管执行，`trace` 只追加事件，`eval` 与 `evidence` 管度量与凭证，`adapter` 是宿主边缘，`cli` 只做参数与输出。依赖方向单向向下，没有循环。

运行时上下文包含技能、tracer、调用方与本次运行的元数据。它不持有全局状态，也不缓存权限判定；每次工具调用都重新核对，因为权限可能随生命周期迁移而变化。Registry 只负责解析与依赖闭包，不负责执行；Lifecycle 只负责状态与钩子，不负责准入。职责分清楚之后，测试可以单独替换任何一层。

五条不变量由测试守护，不靠约定：

1. 上下文显式传递，禁止模块级可变单例。tracer、run context、registry 都由调用方构造并注入。
2. 过滤链 `before` 升序、`after` 逆序回卷，短路必须留事件。过滤器抛错与下游拒绝必须区分：下游拒绝交给执行器做失败映射，过滤器自身错误才走 fail-open/fail-closed。
3. 安装前准入优先于宿主预处理。`!`command``、越权 `allowed-tools`、未声明脚本必须能在进入技能目录前被拒绝。
4. 信任等级决定运行时权限上限，T1/T2 永远拿不到脚本执行权。
5. 任何执行先产出 trace 事件再返回结果，失败也不例外。

第五条不变量容易被忽略：失败也要有结果事件。执行器在捕获异常后先写 `execution.result`，再向上抛出带固定错误码的结果；沙箱超时、输出超限、子进程被拦截都走同一路径。这样账本里不会出现「开始了但没有结束」的调用，排障时不需要靠猜。

核心契约保持小而稳定。双文件清单中，`SKILL.md` 的 frontmatter 只保留 `name` 与 `description`，供模型发现；运行时元数据全部放进 `skill.yaml`：

```yaml
name: invoice-reconcile
version: 1.0.0
capabilities: [fs.read, json.parse, exec]
requires: {}
conflicts: []
permissions:
  fs: [data, cases]
  net: []
  exec: ['node scripts/reconcile.mjs']
  data: []
  irreversible: []
trust: certified
eval: cases
```

过滤器契约只有一个方法对与一个顺序字段：

```ts
export interface ToolFilter {
  name: string;
  order: number;
  before?(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>;
  after?(call: ToolCall, result: ToolResult): Promise<ToolResult>;
}
```

准入分四道门。G1 静态扫描覆盖清单与脚本；G2 规则检查输出 finding 与 advisory；G3 在临时副本中试运行已声明命令；G4 核对权限与信任上限。`install` 模式只跑 G1/G2，`full` 模式追加 G3/G4。判定规则简单：任一 error 级 finding 即 deny。findings 去重后按固定顺序排序，保证同一输入的报告可比较。

G2 的输出分两级：finding 影响裁决，advisory 只提示。这样可以把「确定越界」与「值得人工看一眼」分开，避免把启发式判断伪装成确定性结论。advisory 也进入报告与 trace，但不会改变退出码；需要严格模式时，由 CI 自行把特定 advisory 提升为失败。

信任等级到权限上限的映射是硬编码的：

| trust | tier | exec | net | fs | data | irreversible |
|---|---|---|---|---|---|---|
| community | T1 | 否 | 否 | skill-read | - | 否 |
| reviewed | T2 | 否 | 否 | skill-write | - | 否 |
| vendor | T3 | 是 | 是 | skill-write | pii | 是 |
| certified | T4 | 是 | 是 | declared-write | pii, secrets | 是 |

执行器在调用处理器之前再次核对：tier 是否允许 exec、命令是否在 `permissions.exec` 中、网络目标是否命中 `permissions.net` 白名单、文件路径是否落在允许的根目录内、不可逆操作是否声明。任何一项不满足都返回固定错误码，不进入处理器。

默认过滤顺序为限流（10）→ 身份（20）→ capability（30）→ DLP（40）→ 审计（50）。限流用滑动窗口；身份检查调用方角色；capability 把工具名映射到能力并核对声明；DLP 拦截 secrets，允许声明过的 PII 并避免回显；审计在 `after` 阶段写摘要与记录。过滤器自身错误按副作用分级：策略错误 fail-closed，只读操作上的非策略错误 fail-open 并标记降级，变更与不可逆操作 fail-closed。

失败映射固定，不由技能作者决定：

| 失败类别 | 重试 | 处理 |
|---|---|---|
| transient | 最多 3 次，指数退避 | 继续执行 |
| semantic | 0 | 升级人工 |
| policy | 0 | 隔离并告警 |
| environment | 0 | 快速失败 |
| unknown | 1 | 升级人工 |

分类依据错误码前缀与错误类型，而不是错误文案。`ETIMEDOUT`、`ECONNRESET`、`5xx` 归为 transient；参数与校验错误归为 semantic；权限与策略拒绝归为 policy；命令不存在、解析失败归为 environment；其余归为 unknown。每次重试都写 `execution.retry`，最终结果写 `execution.result`。

重试只对 transient 生效，且每次重试都重新走过滤器与权限检查，不绕过限流与审计。语义失败不重试，是因为重复调用不会让错误的参数变正确；策略失败直接隔离，是因为继续调用只会扩大影响；环境失败快速失败，是因为缺依赖、缺命令这类问题重试也不会自愈。

trace 事件类型固定为 24 类，覆盖 run、admission、lifecycle、post-process、tool、filter、audit、execution、sandbox、supervisor、eval、evidence 与 adapter。事件对象在发出时冻结，tracer 不提供全局单例；CLI 把事件写入 `.agent-skill/trace.jsonl`，测试断言事件集合与声明集合完全相等。这样做的目的是让「覆盖全部事件类型」成为可执行的验收，而不是文档里的口号。

账本按行追加，单行是一个完整 JSON 对象，包含 runId、时间、类型与载荷。读取时跳过损坏行并保留其余事件，避免一次写入失败导致整份账本不可用。事件对象在创建时冻结，过滤器与执行器拿到的是只读视图，不能偷偷改写历史。

评测与证据是同一件事的两面。runner 负责重复执行与记录，metrics 负责统计，evidence 负责把结果固化成可核对的卡片。Wilson 区间用于小样本下的 `pass@1`，`pass^k` 表示 k 次全部通过的比例，`cost_per_success` 只统计成功样本的成本，`p95_latency` 使用最近秩，`escalation_rate` 统计升级人工的比例。证据卡写入 `evidence.json`，其稳定序列化的 sha256 写入 `evidence.lock`；校验时重新计算并比对，任何篡改都会失败。

证据卡的 `integrity` 是技能目录内容哈希，计算时排除 `evidence/` 与临时文件，避免「生成证据」这个动作改变被证明的对象。`gates` 记录每道门的状态：通过、失败或跳过；跳过必须显式出现，不能用缺省值冒充通过。`known_failures` 保留失败用例的 id 与原因，不允许只留一个成功率。

适配器是边缘组件，不是第二套运行时。它把 hook 载荷转换成 `ToolCall`，复用同一套过滤器与 trace，然后返回 Claude 期望的 `permissionDecision`。它不执行技能脚本，也不复制准入逻辑。限制写在代码常量里，避免文档与实现漂移。

监督器与沙箱的边界也要说清：监督器管重启强度，不管业务正确性；沙箱管进程资源与路径，不管模型输出是否可信。把两者混在一起会让责任不清：重启次数正常不代表技能安全，沙箱没报错也不代表结果正确。

## 6. 对比与优势

| 能力 | skillpm | Skilldex | Claude Code 宿主 | LangSmith | 本方案 |
|---|---|---|---|---|---|
| 技能分发 | 有 | 有 | 目录 | 无 | 不做 |
| 格式评分 | 无 | 有 | 无 | 部分 | 轻量 |
| 预处理前准入 | 无 | 无 | 无 | 无 | 有 |
| 技能级能力清单 | 无 | 元数据 | 工具级 | 无 | 有 |
| 运行时强制 | 无 | 无 | 有（可绕过） | 无 | 有 |
| 可证伪证据 | 无 | 无 | 无 | 有评测 | 有（哈希 + 来源） |
| 框架耦合 | 低 | 低 | 高 | 中 | 低 |

对比表只描述分工，不证明优劣。真正的差异在时点：预处理器在模型之前运行，只有安装前准入与 standalone 加载器能拦；证据卡把「作者说它行」换成「有哈希的运行结果」；信任等级不是标签，而是执行器每次调用都会检查的上限。

以「预处理前准入」为例，竞品并非做不到扫描，而是没有把扫描放在技能进入宿主的路径上。Skilldex 的评分可以帮助选择，但不能阻断；Claude Code 的权限在工具层，技能加载前的命令已经执行；LangSmith 的评测覆盖输出质量，不覆盖安装时行为。本方案把位置前移，代价是要维护一套独立的准入与证据格式。

三条优势句各自对应可运行证据：

1. 别人管「装」，我们管「装之前和跑之后」。对应 `verify` 的退出码、findings 与 `eval` 的证据文件。
2. 别人告诉你技能声明了什么，我们给出它实际做了什么的证据。对应 `evidence.json` 与 `evidence.lock` 的哈希校验。
3. 别人把信任写在元数据里，我们让信任等级直接决定运行时权限上限。对应 T1 技能执行脚本时的 `TIER_EXEC_DENIED` 与退出码 3。

证据 schema 是唯一可能沉淀下来的标准。字段名固定、类型固定、锁文件算法固定，第三方可以独立实现校验器；只要有两家以上愿意引用，格式就有生命力。适配器是第二条护城河：每接一个宿主，过滤器与 trace 的可移植性就被验证一次，迁移成本也随之下降。

护城河判断必须诚实：技术壁垒低，六到十二个月内会被复制。能留下的是两样东西：证据 schema 成为第三方愿意引用的规范，以及适配器数量。因此 P0 就发布 schema，不等 1.0；适配器只做 hooks-only，先把「同一条 trace、同一套过滤器」做扎实，再谈覆盖更多宿主。

具体做法是把证据卡字段与锁算法写进独立文档，提供最小校验器，并允许第三方在自己的注册表里引用同一份 schema。适配器侧先覆盖 Claude Code，再选一个开源宿主做移植验证；如果第二个宿主需要改动过滤器接口，说明抽象还不够稳定，应先修接口而不是堆适配器。

演示顺序固定为「安装前拦截 → 证据卡 → 运行时拦截」，沙箱只在最后出现，并且必须带一句边界说明。这个顺序不是包装，而是风险优先级：先证明能在进入宿主前拒绝，再证明结果可核对，最后才谈执行时的兜底。

对比表放在架构之后，是因为读者需要先理解三个执法点，才能理解「有」与「无」的差别。把表放在首屏会变成参数竞赛，掩盖真正的差异是时点而不是功能数量。

表达纪律同样固定：每个 PR 的验收描述必须回答「这次改动强化了哪一条优势」；回答不了的改动不做。营销词不进入 README 首屏，不用「企业级」「军工级」「零信任」这类无法验证的形容词。

## 7. 尚未实现与边界

1. 沙箱是进程级，不是内核级。`node --permission` 限制路径，预加载守卫拦截网络与子进程，但原生扩展可以绕过守卫；Node 权限模型本身出过 CVE。沙箱只在 standalone 模式兜底，不是本方案的卖点。
2. 适配器模式无法阻止宿主预处理。hooks 在技能加载后触发，`!`command`` 已在宿主侧执行；只有安装前 `verify` 与 standalone 模式能覆盖。这个缺口不会因为适配器写得更好而消失。
3. G2 语义判定依赖模型时只做三档降级，不做唯一裁决。P0–P2 默认不接模型，保证评测可复现。
4. hooks-only 适配器无法验证状态变更，只能基于消息流断言。PostToolUse 看到的是工具返回，不是文件系统的最终状态。
5. 证据数据为合成用例，`pass^k` 不代表生产分布。真实流量下的失败模式需要另行采样，不能拿示例技能的满分当结论。
6. 无多租户、分布式、UI、模型路由与长会话记忆治理。这些能力需要独立的架构决策，不应塞进运行时内核。
7. 无签名基础设施与中心化注册表，只保留 `ProvenanceVerifier` 接口。谁签发、如何吊销、密钥怎么轮换，都不在本期范围。
8. 依赖解析交给 npm，`evidence.lock` 不是依赖锁。它只证明证据文件未被篡改，不证明依赖树安全。

第 2 条是最容易被误解的边界。有人会问：既然适配器覆盖不了预处理，为什么还要做？因为大多数日常风险发生在加载之后的工具调用，适配器能覆盖这一段的准入与观测，而且复用同一套 trace。把「能覆盖的」做好，把「不能覆盖的」写清，比声称全能更可信。

第 5 条决定了证据卡的解读方式。合成用例适合回归与演示，不适合对外宣称生产可靠性。接入真实项目后，应该用真实流量重建用例集，并重新计算置信区间；在那之前，`pass@1` 只是 harness 的自检。

这些边界会直接进入 README 与 `adapter claude` 的输出。隐藏边界短期能换来更高的感知能力，长期会换来一次不可解释的失败。

## 8. 收益与度量

- 变更风险：模型或技能升级有回归门禁，逃逸率可观测。`eval --k` 与证据锁让「这次升级有没有变差」有可比较的答案。
- 安全暴露面：安装前拦截 `!`command`` 与越权工具声明，把「模型事后发现」变成「进目录前拒绝」。
- 复用成本：兼容 `SKILL.md`，现有技能可直接接入；新增的只是一个 `skill.yaml` 与可选的评测目录。
- 故障归因：trace 加证据卡，定位从小时级降到分钟级。失败映射把「为什么没重试」「为什么被隔离」变成固定事件。
- 接入成本：三个运行时依赖，本地零外部服务可跑通；CI 只做 typecheck、test 与三条 CLI 冒烟。

度量不追求漂亮数字。示例技能的 12 条用例只证明 harness 能跑通，不证明技能在真实业务上的正确率。真正有意义的指标是接入后的回归逃逸率、准入拦截率与平均定位时间，这三项需要在真实项目中积累。

度量指标建议按周采集：准入拦截数、误报数、运行时拒绝数、重试成功率、平均定位时间。前三项衡量准入是否有效，后两项衡量运行时是否可用。只有拦截数没有误报数，会把准入做成阻力；只有成功率没有定位时间，会把证据做成装饰。

## 9. 路线图

0.3.0 完成 P0–P2：准入四道门、过滤链与执行器、沙箱兜底、监督器、评测与证据、Claude hooks-only 适配器。

0.4.0 计划发布独立的 `evidence.schema.json`，让第三方可以引用同一套字段；补第二个宿主适配器，验证过滤器与 trace 的可移植性；把 G3 扩展到更多命令形态，同时保持「非安全边界」的表述。

1.0 之前不承诺多租户、分布式执行、中心化注册表与签名基础设施。是否进入这些方向取决于两件事：证据 schema 是否被外部采用，适配器是否形成维护社区。没有这两项，扩功能只会增加维护面。

0.4.0 之前不扩功能面，先把 schema 与第二个适配器做完。每个版本的验收都必须包含一条端到端链路与一条对抗用例；没有这两条，不发布。

## 10. 契约附录

**finding 编码**（固定六个）：`preprocessing-command`、`undeclared-tool`、`unlisted-script`、`path-escape`、`network-egress`、`dependency-risk`。

**准入模式**：`install` 只跑 G1/G2，适合复制前阻断；`full` 追加 G3/G4，适合发布前或高风险技能。两种模式使用同一份报告结构，CI 可以按 `verdict` 与退出码分流。

**失败映射**：transient 重试 3 次并指数退避；semantic 不重试并升级；policy 不重试并隔离；environment 快速失败；unknown 重试 1 次后升级。

**CLI 退出码**：0 成功；1 用法错误；2 准入拒绝；3 权限或信任等级不足；4 执行失败。

**版本与兼容**：Node `>=22.23.2`；清单 schema 在 0.x 内保持向后兼容，新增字段必须可选；`evidence.schema.json` 在 1.0 前允许增加可选字段，不允许改名字段语义。

**证据卡字段**：`skill`、`version`、`integrity`、`data_source`、`n`、`pass@1`、`pass_at_1_ci95`、`pass^k`、`cost_per_success`、`p95_latency`、`escalation_rate`、`known_failures`、`gates`、`trust_tier`、`model_matrix`、`harness_version`、`generated_at`。`integrity` 是技能目录内容哈希，`gates` 记录 G1–G4 的通过、失败或跳过。

**锁文件**：`evidence.json` 的稳定序列化结果取 sha256，写入 `evidence.lock`。校验失败即视为证据不可信，不允许「只警告」。

**trace 事件**：run.start/end；admission.start/gate/verdict；lifecycle.transition；skill.post-process；tool.before/after/error；filter.error/shortcircuit；audit.record；execution.retry/result；sandbox.start/end/egress-blocked；supervisor.restart；eval.case/summary；evidence.written；adapter.pre-tool-use/post-tool-use。
