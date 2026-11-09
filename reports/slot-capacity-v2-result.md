# Edict 名額判定與持鎖量測

判定：成功。名額證據在取得 workflow.lock 前查詢，持鎖期間只讀取該次快照結果；快照後出現的其他 Run 操作保守計入。本 Run 的在途名額規則不變。

## 判定與快取

原生證據先核對 Dispatch、Run、Task、assignee 與 worker／projection 關係。只有本機明確 terminal-missing、execution-exited、terminal-released 或成功／完成／停止且 settled 才排除；缺少身分、查詢失敗、unknown 與 unverifiable 均計入。

建立成員、成員換手、續辦訊息三個准入入口在鎖外準備證據。鎖內不查 Orca，也不讀取或寫入證據快取。快取位於 EDICT_HOME/capacity-ended，每筆一個 JSON 檔；識別包含 runId、operationId、dispatchId、taskId、memberId，身分改變就不採用舊證據。只快取 ended=true；查詢失敗及未知不快取；快取檔讀寫失敗不改變保守判定規則。

## 測試

| 檢查 | 總數 | 成功 | 失敗 |
|---|---:|---:|---:|
| main 441f582 完整測試 | 205 | 188 | 17 |
| 新版完整測試 | 230 | 213 | 17 |
| 名額與工作流程相關測試 | 74 | 74 | 0 |
| JavaScript 語法檢查 | 26 | 26 | 0 |

新增 25 項測試全部成功，包含前版 18 項與本次 7 項。新增失敗 0，消失失敗 0，17 項環境失敗名稱完全相同。完整名稱與原始輸出分別在 slot-capacity-v2-test-comparison.json、slot-capacity-v2-baseline-tests.txt、slot-capacity-v2-tests.txt。

本次 7 項測試驗證：三個准入入口查詢時沒有持鎖且後續使用快取；快照後新增操作仍阻止超額派工；unknown 與查詢例外不快取；Dispatch、Task、成員或操作身分改變時不使用舊證據。

## 五次 sync 量測

依協調者指示，正式 EDICT_HOME 僅讀取 workflow.json 與 sessions 作為快照。基準與新版均在同一個臨時 EDICT_HOME、同一支程式執行，每次執行前重設相同資料。工作目錄為 C:/Users/USER/orca/workspaces/vampire-web/urchin，呼叫 CLI main 的參數為 sync --run run_196d0722f532 --session claude:57e189de-7318-4955-92b4-905a5562fa9c。

派工終端不是目標 Run 的有效成員，因此只在副本使用固定 owner 測試身分，不執行原生接手。present 被攔阻；start、stop、rename、send、open、takeover 被拒絕；原生呼叫只允許唯讀查詢。量測的 sync 每次實際僅呼叫 worker-list，正式資料與 worker 均未被本量測寫入或操作。總耗時包含 Node 子程序啟動與來源載入；持鎖時間從成功取得 lock 檔案至刪除，包含讀取、更新與原子寫入資料副本。每次 sync 有兩段持鎖。

| 次數 | 基準總耗時 ms | 基準持鎖 ms | 新版總耗時 ms | 新版持鎖 ms |
|---|---:|---|---:|---|
| 1 | 3220.94 | 996.91 / 1086.54 | 2829.54 | 891.88 / 952.30 |
| 2 | 2953.64 | 932.64 / 1000.24 | 2905.94 | 915.52 / 978.68 |
| 3 | 3046.37 | 946.37 / 1019.57 | 2839.57 | 879.93 / 991.00 |
| 4 | 3178.21 | 1006.99 / 1123.57 | 2846.06 | 876.51 / 995.80 |
| 5 | 2877.96 | 934.82 / 960.12 | 2819.26 | 886.35 / 963.73 |

平均總耗時：基準 3055.42 ms、新版 2848.07 ms。平均單次最長持鎖：基準 1038.01 ms、新版 976.30 ms。平均單次累計持鎖：基準 2001.56 ms、新版 1866.34 ms。新版沒有增加持鎖時間；sync 本身不執行名額證據查詢，本量測不將執行時間差異歸因於名額修正。鎖外查詢的保證由三個准入入口與快照競態測試驗證。

量測程式位於 measure-capacity-v2.mjs；沒有在產品程式加入計時輸出。量測資料副本與快取副本均已刪除。

## 同一份快照的名額比較

以下為同一份正式資料快照，分別套用基準與新版計數，不是跨時間比較。其他 Codex worker 可持續更新正式資料；快照 SHA-256 記錄於 slot-capacity-v2-measurements.json。

| Run | 在途操作 前 → 後 | 計入成員 前 → 後 | executor 前 → 後 |
|---|---|---|---|
| run_04be5fe4954f | 3 → 1 | 3 → 1 | 0 → 0 |
| run_6541c35f183b | 13 → 0 | 5 → 0 | 0 → 0 |
| run_196d0722f532（本 Run） | 5 → 5 | 5 → 5 | 1 → 1 |

15 筆已結束操作產生 15 個快取檔；第二輪均命中。剩餘 1 筆缺少原生身分，不快取，仍計入。第二輪呼叫一次 capacityEvidence 處理該缺身分操作，其身分前置檢查不會呼叫 Orca。

## 交付範圍

分支 Splendent/edict-slot-fix-2，基底 441f582。沒有 push、發布或修改版本號。合併識別碼由 worker_done 與交付紀錄提供；既有未追蹤 slot-capacity-delivery.json 不屬於本次變更。
