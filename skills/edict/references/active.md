# 已啟用對話的協調流程

只有 `edict context --session <原生對話ID>` 回傳啟用時才套用此文件。狀態檔存在不代表 active=true。一般問答、使用者追問或要求解釋直接回答，不啟動完整協作流程。

你是目前對話的協調者，不另開主對話。按本對話設定透過 Orca 派工；不更換設定中的代理或模型。先讀專案規則，再載入本次 Orca 入口 `skills get orchestration` 的版本對應指南。首個 dispatch 未指定 Run 時，由 Orca 建立或沿用目前綁定；CLI 保存收據的 Run ID 供後續使用。新獨立工作目標須先用 Orca run-create，並在首次 dispatch 明確指定新 Run；舊工作的喚醒事件仍按原 Run 處理。

## 工作流程

按下列階段進行。讀 [角色及審查規格](workflow.md) 取得各階段的輸入與交付格式。主對話保留派工權；worker 不自行派出其他 worker。

1. **需求與規劃**：你整理目標、邊界、使用者授權與驗收標準；派 `zhongshu` 唯讀規劃。一般問答直接回答；既有任務的修正沿用原流程。
2. **方案審查**：把需求與完整方案派給全新的 `menxia`。退回則把具體問題交還規劃者修正後再審。最多三輪；第三輪仍退回就回報未解問題與必要決策，不強制通過、不進入實作。
3. **派工與執行**：方案通過後派 `shangshu` 提出派工表。核對它符合核可方案後，你用 `edict dispatch` 啟動實際需要的部門。只派相關角色；有相依的工作等前置成果完成再派，不把所有部門各啟動一次。
4. **驗收與修正**：成果完成後派未參與製作的 `xingbu`，提供原始需求、核可方案、實際變更位置與驗證證據。退回交原執行者修正，再交獨立審查；最多三輪仍不通過就回報剩餘問題。規劃者與作者自述不能取代獨立驗收。
5. **整合與回報**：依專案規則整合已通過成果，必要時交 `shangshu` 彙整。向使用者報告具體結果、驗證與未完成事項。審查任務的 `worker_done succeeded` 只代表已完成審查；正文的「通過／退回」才是是否進入下一階段的依據。只有相關實作、驗收與整合全部完成才能宣稱整個工作完成。

## 實際派工

以工具的結構化檔案寫入方式把自含任務存成 UTF-8 檔案；內容含原始需求、允許修改範圍、前置成果位置、驗收方式。不要把含反引號或 `$()` 的內容直接拼進 shell。使用 ASCII 角色 ID：

```sh
edict dispatch zhongshu --session <本對話ID> --spec-file /tmp/edict-plan.txt --run <run-id> --worktree current
```

CLI 從目前對話的角色設定取得代理／模型，經 stdin 交給 Orca；成功收據的 Run／Task／Dispatch ID 另存此對話狀態。派工時沿用目前工作目錄，明確指定 --worktree。不要用專案目錄或終端機作為對話身分。

- 唯讀角色可用 `current`；可能同時修改檔案的 worker 使用 Orca 建立的獨立工作樹，例如 `--worktree new-top-level --repo id:<repo-id> --name edict-bingbu`。先用 `<入口> repo list --json` 取得實際 ID。不要自行 git checkout 建立 worker 工作樹。
- 檔案位置以執行者收據中的工作樹為準。新工作樹不含未 commit 的變更；先確認基準包含待審內容，或給審查者完整實際檔案路徑。整合變更依專案規則，不擅自 commit、merge、push 或發布。
- 保留收據，依收據 `next` 指示處理。啟動本階段所有獨立 worker 後**結束本輪**，讓 Orca 在回報時喚醒你。這是等待方式，不代表任務完成；不能為了「持續工作」輪詢、sleep 或開另一輪重複派工。
- 喚醒後執行 Orca 提供的 `check` 指令，只處理本 Run 的事件。有明確答案的 worker 問題以 `reply` 回覆；需使用者決定才向使用者問一個具體問題。接著推進下一個可執行階段，不停在方案通過就宣稱完成。
- 追問及修正以 `<入口> orchestration send --to dispatch:<id> --subject "修正要求" --body "具體內容"` 傳送；保留完整內容並依 shell 規則引用。關閉 worker 的後續工作是否重新啟動，以 Orca 收據為準。
- 啟動失敗或結果未知時，保留原始輸出並讀 `<入口> skills get orchestration --reference references/recovery-and-cleanup.md`；不直接重試、不因沉默推定停止。取消也依該指南處理，不直接關閉終端機。
