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

### 讀取其他工作樹（extraReads）

需求、方案與委派可另以 extraReads 宣告 Run 專案以外的讀取根目錄，例如工作要從另一個 git 工作樹搬移成果：

```json
{"extraReads":[{"root":"C:/Users/USER/orca/workspaces/vampire-web/poe-gems-batch1","reads":["src","public"]}]}
```

root 必須是既有目錄的絕對路徑（Windows 須含磁碟代號或 UNC）；工具以實際路徑保存；同一目錄的多筆項目合併，比對子集時以實體目錄識別，因此 UNC（例如 `\\localhost\C$\...`）與磁碟代號寫法指向同一目錄時視為相同根目錄。reads 相對該根目錄，規則與專案 reads 相同，不接受 `..`、絕對路徑或 glob。方案的 extraReads 省略時沿用需求，委派省略時沿用方案；每個根目錄及其 reads 都必須是上一層的子集。派工時這些範圍與專案 reads 一起計入讀取占用，以實體路徑比對：其他操作正在寫入該工作樹（例如以 `path:` 派工到該目錄）的重疊路徑時拒絕派工，範圍不重疊時可並行。extraReads 只授權讀取；writes 仍只限該委派的單一工作樹（current、new-child 或 `path:`）。

### git 中繼資料資源（git:）

commit、merge、rebase、建立分支或標籤等會寫入 git 中繼資料（refs、物件、設定等）的操作，必須在 resources 宣告 `git:<common dir>`。同一 repo 的所有工作樹共用一個 common dir，因此兩個宣告同一 common dir 的操作會以既有資源互斥機制排隊，不同 repo 不互相阻擋。取得 common dir 的絕對路徑：

```sh
git -C /absolute/worktree rev-parse --path-format=absolute --git-common-dir
```

例如 `C:/Users/USER/orca/workspaces/vampire-web/urchin` 的 `.git` 是指向 `C:/workspace/vampire-web/.git/worktrees/urchin` 的檔案，其 common dir 為 `C:/workspace/vampire-web/.git`，資源寫成 `git:C:/workspace/vampire-web/.git`。工具核對該目錄存在且含 `HEAD`，拒絕單一工作樹的 git dir（含 `commondir` 檔，例如 `.git/worktrees/urchin`），並把名稱正規化為實際路徑，不同寫法指向同一 repo 時視為同一資源。git 中繼資料不屬於任何專案相對路徑，writes 不涵蓋它；未宣告 `git:` 資源的委派不得 commit 或 merge。這是協作占用約定，不是 OS 存取沙箱。

建立前 root 先依 [啟用後的協調流程](active.md) 與在途及排隊項目比對 reads／writes／resources／相依。沒有實際重疊時，為新項目選用不同的資源名稱（例如另一個 port）或工作樹，不沿用其他項目的互斥資源。

### root 修訂需求

需求建立後，原對話可用 `work amend` 取代 resources，或擴大 reads 與 extraReads。writes、驗收等其他欄位不能用此命令變更：

```sh
edict work amend --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --work W-001 --spec-file /tmp/edict-amend.json
```

`/tmp/edict-amend.json`：

```json
{"generation":1,"resources":["vite-5217"],"reads":["src","api","vite.config.ts","package.json"],"reason":"vite-5216 由 W-013 使用，改用獨立 port；實作須讀取 api 與建置設定"}
```

JSON 只接受 generation、resources、reads、extraReads、reason，三個範圍欄位至少提供一項，省略的欄位不變。resources 為修訂後的完整清單，可任意取代。reads 與 extraReads 也是修訂後的完整清單，但只能擴大：新的 reads 必須涵蓋目前每個 reads，extraReads 必須保留目前每個根目錄並涵蓋其 reads，縮小一律拒絕。JSON 帶 writes 時拒絕；需要新的寫入範圍時建立新工作項目（`control restart` 保留原 writes，不能用來改寫入範圍）。以下情況拒絕且不改資料：呼叫者不是原對話、generation 與目前世代不符、項目已 Done 或已取消、Run 已取消或停用、本世代仍有在途或結果未確認的 executor 操作、本世代已有交付成果（已提交 work result 的 implementation，含已結束者）。已有成果時須以 `control cancel`／`restart` 重新授權或建立新工作項目。暫停中的項目或 Run 仍可修訂。修訂成功會清除目前方案並遞增 revision，只擴大 reads 或 extraReads 也一樣，因此原有門下核可隨之失效；舊方案的 executor 之後提交的成果只封存，不計入交付。中書須依修訂後的需求重新 `work plan`，門下重新審查後才能派工。修訂內容（`changes` 內各欄位的原值與新值、原因、被清除的方案 digest）記錄在 `work show` 的 `history`。v0.4.0-beta.7 寫入的修訂紀錄格式為 `{field, from, to}`（只有 resources），v0.4.0-beta.8 起為 `{changes}`；既有資料可能同時含兩種格式，讀取時兩者都要處理。

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

方案的 description 必須包含「並行分析」：先 `work show` 列出所有在途或排隊（未 Done、未取消）的其他項目，逐項比對本方案的 reads、writes、resources 與 dependencies，對每一項寫出「可並行」或「需排隊」及具體原因，例如「W-013 寫入 src/vfx，本方案只讀寫 src/growth，資源不同，可並行」或「W-014 寫入 src/codex，本方案讀取 src/codex，需排隊」。判斷基準：

- 任一方寫入的路徑與另一方讀取或寫入的路徑重疊，需排隊。
- 唯一衝突是共用的工具資源（例如同一個 dev server port），而檔案範圍沒有重疊時，不排隊；改提出不同的資源名稱（例如 vite-5217）。該資源不在需求授權內時，以原生 ask 請 root 以 `work amend` 修訂需求資源，再提交方案。
- dependencies 只列真正需要前一項成果的項目；能獨立驗收的項目不列為相依。

寬的讀取範圍同樣會占用：讀取整個 `src` 的委派會阻擋其他項目對 `src` 底下任何路徑的寫入，反之亦然。方案及後續 delegate 都應宣告實際需要的最窄 reads／writes，不以 `src` 或 `*` 代替具體目錄。工具拒絕派工時會列出衝突的工作 ID、角色／職位、operation ID 與衝突維度（共用工具資源，或寫入/寫入、寫入/讀取、讀取/寫入的宣告範圍），據此調整範圍或改為排隊。

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

門下審查必須核對中書的並行分析：在途及排隊項目是否列齊、每個「可並行」結論是否確實沒有讀寫重疊、每個「需排隊」是否有實際重疊或真正相依，以及只因共用工具資源而排隊時是否已提出不同資源名稱。缺少或有誤即退回，不以「保守排隊」代替分析。

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

## 成員換手（team replace）

要讓同一職務改由新的代理或模型接手，或原成員上下文已用盡時，由該成員的直接上級執行 team replace：root 換三省頭領，尚書換部尚書，部尚書換本部郎中。換代理或模型先由 root 以 `config set` 修改設定（只影響之後啟動的成員），再換手。

```sh
edict team replace "$EDICT_MEMBER_ID" --session "$EDICT_SESSION_ID" --run "$EDICT_RUN_ID" --spec-file /tmp/edict-replace.json
```

`/tmp/edict-replace.json`（執行代理須帶所屬工作的目前 generation；頭領不需要）：

```json
{"generation":1,"spec":"接續 W-001 冰霜特效：讀原成員的報告與 work show，完成剩餘測試並提交成果。"}
```

條件：原成員已結束且 sync 確認（沒有 submitted、accepted 或 unknown 操作）；它發起的操作沒有結果未確認；它送出的訊息都已送達，沒有待 owner 轉交。執行代理還須符合同一工作世代與方案、有效門下核可、前置工作已結案，且工作未暫停或取消。頭領仍在執行時，上級先以 team send 請它保存交接說明並回報 worker_done，sync 後再換手。

新成員沿用原職稱、直接上級、工作 scope；執行代理另沿用原委派的 reads、writes、resources、worktree、phase 與分頁標題，並以目前設定啟動。原生確認啟動後，原成員停用（retired，記錄 replacedBy），原頭領的下屬改由新頭領管理；執行代理的原委派標為 superseded，目前成果清除，須由新成員重新交付。原生明確拒絕且沒有副作用時，原成員保持有效；結果未知時由發起的上級 recover，不重送。停用成員不能再呼叫 Edict，送給它的 team send 會被拒絕並指出新成員。原頭領停止後，其下屬晚到的原生事件可能改送 root 信箱，由 root 依既有路由轉交；此情境尚未原生實測。

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

設計型工作（需求 writes 為空、沒有任何 implementation 交付）以方案本體為交付物：門下核可方案後，closure-confirmation 的 digest 填目前方案 digest，不需 work result 與刑部 artifact-acceptance；仍須沒有在途 executor。只要需求授權了寫入，就必須有成果與刑部驗收。

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
