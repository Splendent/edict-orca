---
name: edict
description: 在目前 Orca 對話依 Edict 三省六部流程規劃、獨立審查與派工，並按專案設定指定 Claude、Codex、Cursor 及模型。適用於使用者要求 Edict、三省六部協作或設定 Edict 角色；一般問答不啟動多代理流程。
---

# Edict：目前對話協調，多代理分工

使用者留在目前對話。你是協調者，負責太子的需求整理與角色間轉交；不啟動另一個協調者或網頁。Edict 的角色是工作職責，代理與模型由專案設定決定。不要假裝同一個代理的幾段自問自答就是獨立審查。

## 開始

1. 讀專案指令並執行 `edict config`。尚未初始化時，引導使用者在專案根目錄執行 `edict init`。本輪已有設定可沿用；使用者改模型後重新讀取。不能自行填入模型或換供應商。
2. 依 `ORCA_CLI_COMMAND` → `ORCA_DEV_REPO_ROOT` 對應 `orca-dev` → Linux `orca-ide` → 其他平台 `orca` 的順序，選定本次 Orca 入口並執行 `<入口> skills get orchestration`；先讀回傳的版本對應指南。不要另開自製信箱或背景輪詢。
3. 正式工作以 `<入口> orchestration run-create --objective "需求摘要" --json` 建立 Run。延續既有工作時沿用該 Run，不重複建立。將 Run ID、各 Task／Dispatch ID、角色與審查輪次保留在對話交接；需要恢復時讀 `run-show`／`inbox` 的既有紀錄。

`edict doctor` 可檢查專案設定、技能安裝與 Orca 就緒狀態；它不驗證帳號、模型或工作成果。必要時才執行，不能把成功當作實際派工成功。

## 工作流程

按下列階段進行。讀 [角色及審查規格](references/workflow.md) 取得各階段的輸入與交付格式。主對話保留派工權；worker 不自行派出其他 worker。

1. **需求與規劃**：你整理目標、邊界、使用者授權與驗收標準；派 `zhongshu` 唯讀規劃。一般問答直接回答；既有任務的修正沿用原流程。
2. **方案審查**：把需求與完整方案派給全新的 `menxia`。退回則把具體問題交還規劃者修正後再審。最多三輪；第三輪仍退回就回報未解問題與必要決策，不強制通過、不進入實作。
3. **派工與執行**：方案通過後派 `shangshu` 提出派工表。核對它符合核可方案後，你用 `edict dispatch` 啟動實際需要的部門。只派相關角色；有相依的工作等前置成果完成再派，不把所有部門各啟動一次。
4. **驗收與修正**：成果完成後派未參與製作的 `xingbu`，提供原始需求、核可方案、實際變更位置與驗證證據。退回交原執行者修正，再交獨立審查；最多三輪仍不通過就回報剩餘問題。規劃者與作者自述不能取代獨立驗收。
5. **整合與回報**：依專案規則整合已通過成果，必要時交 `shangshu` 彙整。向使用者報告具體結果、驗證與未完成事項。審查任務的 `worker_done succeeded` 只代表已完成審查；正文的「通過／退回」才是是否進入下一階段的依據。只有相關實作、驗收與整合全部完成才能宣稱整個工作完成。

## 實際派工

以工具的結構化檔案寫入方式把自含任務存成 UTF-8 檔案；內容含原始需求、允許修改範圍、前置成果位置、驗收方式。不要把含反引號或 `$()` 的內容直接拼進 shell。使用 ASCII 角色 ID：

```sh
edict dispatch zhongshu --spec-file /tmp/edict-plan.txt --run <run-id> --worktree current
```

CLI 會加入角色指令，從 `.edict/config.json` 取得代理／模型，將完整任務經 stdin 交給 Orca `worker-start --spec-file -`，並原樣輸出收據。用 `--dry-run` 可預覽實際參數而不啟動代理。

跨工作樹時以 `edict --project <原專案根目錄> dispatch ...` 讀取同一份設定。程式不更改目前工作目錄；`--worktree` 仍須指向這次預定操作位置。

- 唯讀角色可用 `current`；可能同時修改檔案的 worker 使用 Orca 建立的獨立工作樹，例如 `--worktree new-top-level --repo id:<repo-id> --name edict-bingbu`。先用 `<入口> repo list --json` 取得實際 ID。不要自行 git checkout 建立 worker 工作樹。
- 檔案位置以執行者收據中的工作樹為準。新工作樹不含未 commit 的變更；先確認基準包含待審內容，或給審查者完整實際檔案路徑。整合變更依專案規則，不擅自 commit、merge、push 或發布。
- 保留收據，依收據 `next` 指示處理。啟動本階段所有獨立 worker 後**結束本輪**，讓 Orca 在回報時喚醒你。這是等待方式，不代表任務完成；不能為了「持續工作」輪詢、sleep 或開另一輪重複派工。
- 喚醒後執行 Orca 提供的 `check` 指令，只處理本 Run 的事件。有明確答案的 worker 問題以 `reply` 回覆；需使用者決定才向使用者問一個具體問題。接著推進下一個可執行階段，不停在方案通過就宣稱完成。
- 追問及修正以 `<入口> orchestration send --to dispatch:<id> --subject "修正要求" --body "具體內容"` 傳送；保留完整內容並依 shell 規則引用。關閉 worker 的後續工作是否重新啟動，以 Orca 收據為準。
- 啟動失敗或結果未知時，保留原始輸出並讀 `<入口> skills get orchestration --reference references/recovery-and-cleanup.md`；不直接重試、不因沉默推定停止。取消也依該指南處理，不直接關閉終端機。

## 設定

`edict init` 設定共用代理／模型，接著可逐一調整角色。`null` 表示沿用該工具預設；不推測模型 ID。變更只影響新啟動的 worker，不改目前對話或已執行中的模型。

```sh
edict config set menxia --agent codex --model <使用者指定的模型ID> --effort high
edict config set bingbu --agent cursor --model <使用者指定的模型ID>
edict config set menxia --clear-model
```

`effort` 必須搭配明確模型；實際支援值由工具與模型決定，失敗時不自動降級。使用者填入設定即代表其模型選擇，不再要求逐次重複確認。CLI 不讀取帳號憑證。角色清單以 `edict roles` 查詢。

若新技能尚未出現在既有對話清單，直接讀專案 `.agents/skills/edict/SKILL.md` 即可沿用目前對話；不要求使用者另開對話。
