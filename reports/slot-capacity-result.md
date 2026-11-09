# 派工名額修正驗證

基線比對結論：沒有新增測試失敗。main 基線 d8dd24a4d7918d58d472c8a21f4a180de15caf22 的 17 項失敗與修改後相同，依本次任務授權可提交及合併；完整測試仍有既有環境失敗，不宣稱全部成功。

## 修改範圍

- src/native.mjs：NativeRuntime.capacityEvidence 以 worker-show 唯讀查詢原生證據。
- src/workflow.mjs：capacityOperations 計算占用；claim 及 launch、replace、message 的准入呼叫使用此計算。
- test/capacity.test.mjs、test/workflow.test.mjs：原生身分核對、證據判定、跨 Run 准入及本 Run 上限測試。
- skills/edict/references/scheduling.md：記錄名額及範圍占用規則。

## 判定規則

本 Run 的 submitted、accepted、unknown 操作保持既有占用。其他 Run 操作須有 Dispatch 與 Task，且 worker-show 的 Dispatch、Run、Task、worker assignee 與 projection 身分全部一致；本機 observation.status=missing、projection.liveness.verdict=exited、明確終端 released，或成功／完成／停止且 worker stage=settled，才不計入准入名額與範圍占用。unknown、unverifiable 本身不是結束證據，身分缺失或查詢失敗時保留占用；不以時間判斷，不改寫其他 Run，不改身分核對，不停止或釋放 worker。

## 驗證結果

main 完整 npm test：188／205 成功，17 項失敗，exit=1；原始輸出見 slot-capacity-baseline-tests.txt。修改後完整 npm test：206／223 成功，17 項失敗，exit=1；原始輸出見 slot-capacity-tests.txt。新增的 18 項測試全部成功。失敗包含 Windows 原生 spawnSync 無法執行測試用 shebang 腳本（EFTYPE／ENOENT）、建立符號連結權限不足（EPERM），以及 POSIX shell 測試；未修改無關平台支援。相關 node --test test/capacity.test.mjs test/workflow.test.mjs：67／67 成功。npm run check：26／26 成功；git diff --check 成功。本機 WSL 未安裝，未宣稱 Linux 測試成功。

逐項比對見 slot-capacity-test-comparison.json：17 項名稱完全一致，錯誤訊息、錯誤碼及實際／預期值一致；只正規化暫存目錄、repo 根路徑及因新增方法而改變的堆疊行號。沒有只在修改後失敗的項目。部分 CLI 測試只顯示同一個 exit assertion；原始輸出未直接揭露底層原因，不將其單獨斷定為 EFTYPE。

## 指定目錄唯讀診斷

這是未合併工作樹的診斷，不是原規格步驟 6 的合併後驗證。執行目錄 C:/Users/USER/orca/workspaces/vampire-web/urchin，EDICT_HOME=C:/Users/USER/.config/edict-v2；只讀 workflow.json 與 Orca worker-show，沒有修改該專案或 Edict 資料。計算前後 workflow.json SHA-256 一致。

| Run | 成員原數 | 成員修正數 | executor 原數 | executor 修正數 |
| --- | ---: | ---: | ---: | ---: |
| run_6541c35f183b | 5 | 0 | 0 | 0 |
| run_04be5fe4954f | 3 | 1 | 0 | 0 |
| run_196d0722f532 | 1 | 1 | 0 | 0 |

人數依 memberId 去重，因此 run_6541c35f183b 的 13 筆在途操作是 5 位成員。15 筆排除操作皆取得 terminal-missing 證據；run_04be5fe4954f 的 3aa8a15d-b26f-49df-a7bc-d13e940bc335 缺少 Dispatch／Task，保留 1 位成員。逐筆 operation、member、Dispatch、Task 與理由見 slot-capacity-observation.json。目前 Run 完全未查詢或排除，這次快照沒有在途 executor，不能證明其他時間的 executor 數。

## 交付記錄

合併 commit 與正式合併後唯讀計算另記於 slot-capacity-delivery.json。未 push、未發布、未改版本。
