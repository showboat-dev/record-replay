# 参数化建议（Phase 1，规则召回 + 一键采纳）

> 目标用户：业务人员。录完流程后，系统提示"这个值每次都变，要不要变成运行参数？"，
> 用户一键接受/改名/忽略/同值批量，IR 从写死值变成 `{{变量}}` + `variables[]`。
>
> 设计原则：**确定性规则只圈候选（recall），AI 负责裁决/命名（Phase 2），用户保留拍板权**。
> 建议是即时计算、不持久化；只有「接受」才写 IR。

## 1. 数据结构（`@rr/suggest`，已冻结）

见 `packages/suggest/src/types.ts`：`ParamSuggestion` / `FlowSuggestions` / `ApplySuggestionInput` / `AnalysisOptions`。
要点：

- `confidence: 'high' | 'medium' | 'weak'`；UI 默认只展示 high+medium；
- `reasons: string[]` 中文，UI 直接展示；
- `group?: { value, stepIds }` 同值批量候选（含自己）；
- `skipped: { stepId, stepIndex, reason }[]` 明确排除的步骤及原因。

## 2. 候选与排除

**候选**：`input` / `select`（value 为 string）步骤，value 非空且不含 `{{`。
**直接排除（进 skipped，附中文原因）**：

- password/secret 目标（值已被 masking）
- value 为空/纯空白
- `select.value` 为数组（多选下拉）
- `upload`（录制器已自动变量化）
- click/key/hover/dialog/switchTab 等非数据步骤
- 已含模板 `{{...}}`

## 3. 规则（打分，可叠加）

| 信号                                                                                                                                                                                                                                                                          | 分               | 例子                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| input type ∈ email/tel/date/number/url                                                                                                                                                                                                                                        | +3               | `type=email`                         |
| 值格式匹配 email / 手机号 / 日期 / 金额 / 长编号                                                                                                                                                                                                                              | +2               | `a@b.com`、`2026-01-01`、`¥1,200.00` |
| label/placeholder/name/id 命中业务字段词表（中文：姓名/名称/用户名/客户/公司/地址/邮箱/邮件/电话/手机/金额/价格/数量/单号/订单/编号/身份证/账号/日期/时间/城市/国家；英文：name/email/phone/address/amount/price/qty/quantity/order/no/id/account/date/city/country/company） | +3               | 「报销金额」                         |
| 同一值出现在 ≥2 个候选步骤                                                                                                                                                                                                                                                    | +2（生成 group） | 邮箱填了两次                         |
| 1–3 位纯数字 + 数量/件数/个数 词                                                                                                                                                                                                                                              | +1               | 「数量: 2」                          |
| **负向**：label/placeholder 含 搜索/查找/筛选/search/filter/query，或 target 有 `aria-autocomplete` / `role=combobox`+`aria-haspopup=listbox`                                                                                                                                 | −4               | 「搜索订单」→ 判为固定操作           |
| **负向**：textarea 且 label 属泛化文本（简介/备注/说明/remark/note/comment）                                                                                                                                                                                                  | −2               | 「简介」                             |

**置信度**：≥5 high；≥3 medium；否则 weak（默认不返回，`includeWeak` 才给）。
**排序**：confidence 高优先，再按 stepIndex 升序。

## 4. 命名与类型

中文词表 → ASCII：姓名→name、用户名→username、邮箱→email、手机/电话→phone、地址→address、金额/价格→amount、数量→quantity、单号/订单号→order_no、编号→code、身份证→id_number、日期→date、账号→account、公司→company、客户→customer、城市→city、国家→country、备注→remark、简介→bio。
英文 label → snake_case（非法字符剔除）。
兜底：`field_<stepIndex+1>`。
查重：与 `flow.variables` + 本批已分配名字一起查，重复则 `_2`、`_3`…（按步骤顺序确定）。

类型推断：`email`/`tel` → `email`；`date` → `date`；`number`/金额/数量 → `number`；泛文本 → `text`；其余 `string`。

## 5. 应用语义（`applySuggestion` / `applySuggestions`）

- 把 `step.value` 替换成 `{{name}}`；
- 变量定义：`{ name, type, secret:false, source:'input' }`（若同名变量已存在且类型兼容则复用）；
- `applySameValue=true` 且 `group` 存在 → 组内所有步骤一起替换（已是模板的跳过）；
- 纯函数：深拷贝返回新 flow，不动 `version`；落盘由 Studio 的 `updateFlow`（`.bak` + version+1）负责；
- 非法输入抛 `SuggestError`（`INVALID_NAME` / `NAME_CONFLICT` / `STEP_NOT_FOUND` / `UNSUPPORTED_STEP` / `VALUE_ALREADY_TEMPLATED` / `EMPTY_VALUE`），Studio 转 400 + 中文原因。

## 6. Studio API（新增）

| 方法 | 路径                                         | body                                       | 返回                               |
| ---- | -------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| GET  | `/api/flows/:file/suggestions?includeWeak=0` | —                                          | `FlowSuggestions`                  |
| POST | `/api/flows/:file/apply-suggestion`          | `{ stepId, name, type?, applySameValue? }` | `{ ok, flow, steps, suggestions }` |
| POST | `/api/flows/:file/apply-suggestions`         | `{ apply: ApplySuggestionInput[] }`        | 同上（先整体校验，全部合法才落盘） |
| POST | `/api/flows/:file/variables/rename`          | `{ from, to }`                             | `{ ok, flow }`                     |

错误：参数错/`SuggestError` → 400 `{ error: 中文, code? }`；flow 不存在 → 404；内部错误 → 500。
apply 后不自动自检（UI 有「自检」按钮）。

**响应约定**：apply/apply-suggestions 返回 `{ ok, flow, steps, suggestions }`，其中 `suggestions`
是 apply 后重算的结果；若重算失败返回 `null`（写入已成功，不回滚）——前端需容忍 null。

## 7. Studio 前端交互

1. 选中流程后并行请求 detail + suggestions，`state.suggestions`；忽略状态存 `localStorage`（key 含 file+version），不写 IR。
2. 步骤行：`💡 建议参数化：<name>（高/中）` + 「接受」「修改」「忽略」；悬停/展开显示 reasons。
3. 底部批量条：`参数化建议 N 条` + 「全部接受」（先弹确认列出将生成的变量）+ 「显示已忽略」。
4. 接受弹窗：变量名（预填、ASCII 校验、查重提示）、类型下拉（文本/邮箱/日期/数字）、「同值一起替换（K 处）」勾选（默认勾选，仅 group 时出现）、理由列表。
5. 变量区：显示类型 chip；`file` 类型提示"填文件绝对路径"；新增「重命名」按钮（调 rename API）。
6. 空态/加载/错误/0 console error 照旧。
