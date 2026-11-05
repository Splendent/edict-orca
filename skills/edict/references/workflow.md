# 角色與工作契約

這份文件供已啟用 v2 對話的代理使用。內部命令由有權原生呼叫者執行，不能在 root shell 填一個 member ID 冒充其他角色。JSON 以工具寫 UTF-8 檔，再用 `--spec-file` 傳入；`-` 代表 stdin。

以下 shell 變數須先填入本次實際回傳的 session、Run、成員與 operation ID；`/absolute/...` 路徑和 digest 佔位值也必須替換，不可原樣執行。每個代理沿用派工前言的 EDICT_HOME、session 與 Run。

## 角色與權責

| 角色 ID | 頭領／執行職位 | 責任 |
| --- | --- | --- |
| taizi | 原對話 root | 需求、使用者授權、三省空頭領啟動及控制；不代替門下批准 |
| zhongshu | 中書令／中書舍人 | 調查、唯讀規劃、送審與方案修正 |
| menxia | 侍中／給事中 | 獨立方案審查與結案核對；正式放行及結案由頭領記錄 |
| shangshu | 尚書僕射／左右司郎中 | 管理六部、調度、整合與交付核對 |
| bingbu | 兵部尚書／兵部郎中 | 工程實作與測試 |
| xingbu | 刑部尚書／刑部郎中 | 獨立程式、功能、測試與合規驗收 |
| gongbu | 工部尚書／工部郎中 | 建置、CI、部署及工具；部署仍需明確授權 |
| libu | 禮部尚書／禮部郎中 | 文件、規範、介面文字及對外草稿 |
| hubu | 戶部尚書／戶部郎中 | 資料、統計、資源及成本 |
| libu_hr | 吏部尚書／吏部郎中 | 代理設定、技能與權限配置，不讀憑證 |

欽天監、早朝官設定保留，但不經本階層的尚書六部入口建立管理權。下屬不得再派代理；同部可有多個 executor，作者與獨立審查者必須不同。

## root 建立需求與三省

由原對話執行，保留 `run open` 回傳的 `id` 作為 EDICT_RUN_ID：

```sh
edict run open --session "$EDICT_SESSION_ID" --objective '完成已確認的工作目標'
edict work add --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --spec-file /tmp/edict-work.json
```

`/tmp/edict-work.json`：

```json
{
  "id": "W-001",
  "title": "實作指定功能",
  "requirement": "只修改 src 內已確認的功能並提交測試證據",
  "reads": ["src"],
  "writes": ["src"],
  "resources": [],
  "acceptance": ["實際輸出符合需求", "相關測試成功"]
}
```

新項目自動從 generation 1 開始。reads／writes 是專案相對檔案或目錄，可用單獨 `*`，不接受 glob 或越出專案的路徑。resources 是明確互斥資源名稱；所有後續範圍必須是需求授權的子集。

root 以無 work 的三次 ensure 建立平行頭領：

```sh
edict team ensure zhongshu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --spec-file /tmp/edict-head-empty.json
edict team ensure menxia --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --spec-file /tmp/edict-head-empty.json
edict team ensure shangshu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --spec-file /tmp/edict-head-empty.json
```

`/tmp/edict-head-empty.json`：

```json
{"spec":"依本角色指引讀取 work show。尚未授予工作 scope 時只等待合法業務交接，不審查、不派實作，不自行建立另一位三省頭領。"}
```

保存三次回應的 `member.id`、`member.dispatchId` 及 `operation.id`。中書 scope 為 `*`，門下與尚書為 `[]`；root 啟動不替它們授予具體業務。後續中書／門下只 grant 既有頭領，不改其原生 creator。若尚未有空頭領，透過原生 ask 請 root 建立，不由中書再巢狀建立，避免增加原生深度。

## 中書方案與門下放行

由中書頭領執行：

```sh
edict work plan --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-plan.json
```

`/tmp/edict-plan.json`：

```json
{
  "generation": 1,
  "description": "在 src/result.txt 實作指定成果並提供測試結果",
  "reads": ["src"],
  "writes": ["src"],
  "resources": [],
  "acceptance": ["實際輸出符合需求", "相關測試成功"],
  "dependencies": []
}
```

保存回傳的 `digest`、`revision` 與 generation。dependencies 使用工作項目 ID，需等相依項目 Done 才派工；不是原生 Task ID。共同介面由指定負責者提出，不讓多位作者各自假定。

中書用 `/tmp/edict-head-work.json` 授予既有門下 scope；該檔也供核可後授予尚書使用：

```json
{"generation":1,"spec":"處理 W-001 的目前核定階段；讀取完整需求、方案及證據，不擴大授權。"}
```

```sh
edict team ensure menxia --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-head-work.json
edict team send "$EDICT_MENXIA_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-review-message.json
```

`/tmp/edict-review-message.json`：

```json
{"generation":1,"kind":"handoff","body":"請獨立審查 W-001 的目前方案，核對原始需求、介面、範圍及驗收；將具體證據存檔後記錄 plan-approval。"}
```

ensure 的既有成員回應只是授權 scope，不會自動喚醒；必須另送正式訊息。門下頭領讀實際檔案後寫 `/tmp/edict-plan-review.json`：

```json
{
  "generation": 1,
  "kind": "plan-approval",
  "digest": "替換為目前方案回傳的digest",
  "verdict": "approved",
  "evidence": ["/absolute/reports/plan-review.txt"],
  "reason": "逐項核對需求、介面、範圍及驗收條件的結論"
}
```

```sh
edict review record --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-plan-review.json
```

`verdict` 只接受 approved／rejected。證據必須是有內容依據且可讀取的實際檔案；工具保存其內容摘要。`digest` 指方案或成果的回傳摘要，不是證據檔摘要，也不是自行填寫的版本號。證據檔或方案變更後不可沿用舊放行。

## 尚書與各部派工

核可後由中書或門下授予既有尚書工作，再用 team send 送出交接：

```sh
edict team ensure shangshu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-head-work.json
edict team send "$EDICT_SHANGSHU_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-execution-message.json
```

`/tmp/edict-execution-message.json`：

```json
{"generation":1,"kind":"handoff","body":"W-001 的目前方案已經門下核可。請按 work show 的有效決策管理實作、刑部驗收與必要整合，最後送門下確認結案。"}
```

尚書建立必要部門頭領，不預開所有六部：

```sh
edict team ensure bingbu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-head-work.json
edict team ensure xingbu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-head-work.json
```

兵部頭領用 `/tmp/edict-implementation.json` 建立 executor：

```json
{
  "generation": 1,
  "spec": "依目前核可方案修改 src/result.txt，執行相關測試，提交實際成果與測試報告，不自行擴大範圍。",
  "title": "指定功能實作與測試",
  "phase": "implementation",
  "reads": ["src"],
  "writes": ["src/result.txt"],
  "resources": [],
  "worktree": "current"
}
```

```sh
edict delegate bingbu --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-implementation.json
```

保存回傳 `operation.id`；執行代理應從前言及 work show 核對自己的委派。planning 只屬中書 executor；plan-review／verification 屬門下；coordination 屬尚書；部門 executor 使用 implementation 或 verification。verification 及管理角色沒有專案寫入授權；中書、門下與尚書不能用 implementation 冒充交付。

## 成果、刑部驗收與門下結案

只有六部的 implementation executor 能以自己的 operation 提交交付。`/tmp/edict-result.json`：

```json
{"generation":1,"files":["/absolute/project/src/result.txt","/absolute/edict-state/artifacts/實際operation-id/test-report.txt"]}
```

```sh
edict work result --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --operation "$EDICT_OPERATION_ID" --spec-file /tmp/edict-result.json
```

files 必須是可讀取的實際檔案，位於該委派 writes 或 `EDICT_HOME/artifacts/<operationId>/`。工具核對檔案摘要並彙整同世代、同方案的必要實作貢獻；回傳的 `result.digest` 是整體成果摘要。operation 綁定原世代，JSON 的 generation 不能改派到新工作。審查者和頭領不得用自己的報告取代 implementation 交付。

執行代理提交後依 Orca 前言回報 worker_done。收到結束事件由有權成員 `sync`，確認所有必要 implementation 都已成功結束、每份都有成果、沒有未知副作用。刑部頭領可直接查證，或委派刑部 verification executor 分工；verification 只保存審查證據並記錄驗收，不用 work result 冒充交付。

刑部用 `/tmp/edict-artifact-review.json`：

```json
{"generation":1,"kind":"artifact-acceptance","digest":"替換為目前整體result.digest","verdict":"approved","evidence":["/absolute/reports/artifact-review.txt"],"reason":"實際差異、測試與方案驗收均有依據"}
```

```sh
edict review record --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-artifact-review.json
edict sync --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID"
```

完成所有必要驗收及整合，所有必要 executor 已收斂後，尚書經 team send 向門下申請結案。門下頭領用 `/tmp/edict-closure.json`：

```json
{"generation":1,"kind":"closure-confirmation","digest":"替換為目前整體result.digest","verdict":"approved","evidence":["/absolute/reports/closure-review.txt"],"reason":"需求覆蓋、獨立驗收及整合證據完整，無在途或未知交付"}
```

```sh
edict review record --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-closure.json
edict work show --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID"
```

核對 W-001 為 Done 才回報該項完成。原生 completed、給事中通過文字、最後一位郎中的成功回報或尚書單方面同意均不足以結案。退回只修具體缺口；方案變更須重審，成果變更須重新驗收，不保留舊摘要的有效性。

## 結案後的唯讀通知

Done 後不要再用預設 handoff 傳送完成通知。門下先回報既有尚書，尚書再回報既有中書；各自使用本人的原生身分，不能由同一 root shell 冒充。`/tmp/edict-completion-report.json`：

```json
{"generation":1,"kind":"report","body":"W-001 已完成門下結案。成果摘要、刑部驗收及 closure-confirmation 記錄見目前 work show；此訊息只回報結果，不要求新增工作。"}
```

門下執行：

```sh
edict team send "$EDICT_SHANGSHU_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-completion-report.json
```

尚書核對後執行：

```sh
edict team send "$EDICT_ZHONGSHU_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-completion-report.json
```

report 只允許頭領送既有頭領，仍檢查路由、共同工作 scope、generation 與真實身分。不能送 executor、擴大授權、改驗收或觸發後續業務。Done、pause、cancel、off 後仍可保存及轉達唯讀結果；業務命令繼續受原控制限制。目標需要 owner 代喚醒時，root 依 scheduling.md 原樣 forward，保留 report 種類。root 依原生完成通知及工作視圖向使用者回報，不另建一位 root 頭領接收訊息。
