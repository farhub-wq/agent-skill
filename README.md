别人管「装」，我们管「装之前和跑之后」。
别人告诉你技能声明了什么，我们给出它实际做了什么的证据。
别人把信任写在元数据里，我们让信任等级直接决定运行时权限上限。

# agent-skill

`agent-skill` 是 Agent 技能的可信运行时：在技能进入宿主机之前做准入，在工具调用时按信任等级限制权限，在跑完之后产出可核对的证据卡与 trace 账本。

它兼容现有的 `SKILL.md`，不另建包管理与注册表。运行时依赖只有 `yaml`、`semver`、`zod`，本地零外部服务可跑通。

## 为什么需要它

宿主解析 `SKILL.md` 时可能执行 `!`command`` 预处理。这一刻发生在模型看到第一个 token 之前：凭据可以被外泄，模型的事后判断只是取证，不是预防。

`verify` 和 standalone 加载器能在这之前介入；hooks 适配器不能，因为 hook 在技能加载之后才触发。这个边界写在 [docs/PROPOSAL.md](docs/PROPOSAL.md) 和 `adapter claude` 的输出里，不藏着。

## 三个执法点

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

### 与现有工程的分工

| 能力 | skillpm | Skilldex | Claude Code 宿主 | LangSmith | 本方案 |
|---|---|---|---|---|---|
| 技能分发 | 有 | 有 | 目录 | 无 | 不做 |
| 格式评分 | 无 | 有 | 无 | 部分 | 轻量 |
| **预处理前准入** | 无 | 无 | 无 | 无 | **有** |
| 技能级能力清单 | 无 | 元数据 | 工具级 | 无 | 有 |
| 运行时强制 | 无 | 无 | 有（可绕过） | 无 | 有 |
| 可证伪证据 | 无 | 无 | 无 | 有评测 | 有（哈希 + 来源） |
| 框架耦合 | 低 | 低 | 高 | 中 | 低 |

## 三条命令

仓库内先构建：

```bash
npm ci
npm run build
```

### 1. 安装前准入

```bash
node dist/cli/index.js verify examples/invoice-reconcile --gate install
# verdict: allow，退出码 0

node dist/cli/index.js verify test/fixtures/malicious/preprocessing-command --gate install
# [high] preprocessing-command SKILL.md:line 8: ...，退出码 2
```

`--gate full` 追加 G3 沙箱试运行与 G4 权限核对。CI 里失败即阻断，技能目录不会被复制进宿主。

### 2. 证据卡

```bash
node dist/cli/index.js eval examples/invoice-reconcile --k 5
```

输出 `pass@1`（95% CI）、`pass^k`、`cost_per_success`、`p95_latency`、`escalation_rate`，并在 `examples/invoice-reconcile/evidence/` 写入 `evidence.json` 与 `evidence.lock`。`evidence.lock` 是证据文件内容的 sha256；同一输入与 `--now` 下重复生成内容稳定。

`data_source` 在 P0–P2 恒为 `synthetic`，`pass^k` 不代表生产分布。

### 3. 运行时

```bash
node dist/cli/index.js run examples/invoice-reconcile \
  --input examples/invoice-reconcile/data/input.json
# {"invoiceId":"INV-1001","status":"paid","outstanding":0}，退出码 0

node dist/cli/index.js run test/fixtures/community-exec
# does not permit script execution，退出码 3
```

`run` 走 Registry → Lifecycle → 过滤链 → Executor → trace，账本默认写到 `.agent-skill/trace.jsonl`。

发布后同一套命令通过 `npx agent-skill <command>` 调用；CLI 的 `--help` 首行同样是三条优势句的原文。

## 信任等级与权限上限

| trust | tier | exec | net | fs | data | irreversible |
|---|---|---|---|---|---|---|
| community | T1 | 否 | 否 | skill-read | - | 否 |
| reviewed | T2 | 否 | 否 | skill-write | - | 否 |
| vendor | T3 | 是 | 是 | skill-write | pii | 是 |
| certified | T4 | 是 | 是 | declared-write | pii, secrets | 是 |

T1/T2 永远拿不到脚本执行权。上限由 `src/admission/tier.ts` 固定，技能作者无法在 `skill.yaml` 里自我提权。

## 过滤链与失败映射

默认顺序：限流（10）→ 身份（20）→ capability（30）→ DLP（40）→ 审计（50）→ 执行。`before` 升序、`after` 逆序回卷，每次短路都留 trace 事件。

策略错误一律 fail-closed；只读操作上的非策略错误可 fail-open 并记录降级事件；不可逆操作与变更类操作 fail-closed。

失败映射固定，不由技能作者决定：

| 失败类别 | 重试 | 处理 |
|---|---|---|
| transient | 最多 3 次，指数退避 | 继续执行 |
| semantic | 0 | 升级人工 |
| policy | 0 | 隔离并告警 |
| environment | 0 | 快速失败 |
| unknown | 1 | 升级人工 |

## 安装前 finding 编码

固定六个编码，供 CI 与文档引用：`preprocessing-command`、`undeclared-tool`、`unlisted-script`、`path-escape`、`network-egress`、`dependency-risk`。

## CLI 速查

| 命令 | 作用 |
|---|---|
| `init [dir]` | 生成 `SKILL.md` + `skill.yaml` 骨架 |
| `verify <dir> [--gate install\|full] [--json]` | 准入检查，拒绝时退出码 2 |
| `inspect <dir> [--json]` | 查看清单、信任等级与权限上限 |
| `run <dir> [--input file] [--json]` | 在 standalone 运行时执行已声明命令 |
| `eval <dir> [--k 5] [--now ISO] [--json]` | 评测并写入证据卡与锁 |
| `adapter claude [--dir <dir> --hook]` | 打印 Claude hooks 配置，或处理一条 hook 载荷 |

退出码：`0` 成功、`1` 用法错误、`2` 准入拒绝、`3` 权限或信任等级不足、`4` 执行失败。

## 边界与非目标

1. 沙箱是进程级，不是安全边界：`node --permission` 限路径与写权限，预加载守卫拦网络与子进程，资源上限为 30s / 256MB / 1MB 输出 / 50 文件 / 10MB 写入。原生扩展可以绕过预加载守卫，Node 权限模型本身也出过 CVE。沙箱只在 standalone 模式兜底，不是本项目的卖点。
2. hooks-only 适配器无法阻止宿主预处理：`!`command`` 已在技能加载前执行，只有 `verify` 与 standalone 模式能覆盖。
3. G2 语义判定只做降级建议，不做唯一裁决；无模型时退化为规则检查。
4. hooks-only 适配器无法验证状态变更，只能基于消息流断言。
5. 证据数据为合成用例，`pass^k` 不代表生产分布。
6. 不做多租户隔离、分布式执行、可视化 UI、模型路由与成本优化、长会话记忆治理、自建包管理与注册表。
7. 不做签名基础设施与中心化注册表，只保留 `ProvenanceVerifier` 接口；依赖解析交给 npm，`evidence.lock` 不是依赖锁。

## 开发与测试

```bash
npm run typecheck
npm test          # 单元 + 集成 + 对抗用例
npm run build
```

测试覆盖 schema 边界、`!`command`` 与 `allowed-tools` 解析、过滤链顺序与短路、失败映射、分级策略、沙箱路径与网络拦截、证据卡快照、CLI 退出码，以及一条覆盖全部 24 类 trace 事件的端到端链路。

## 文档与许可

- 设计与边界：[docs/PROPOSAL.md](docs/PROPOSAL.md)
- 漏洞报告：[SECURITY.md](SECURITY.md)
- 许可：Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)
