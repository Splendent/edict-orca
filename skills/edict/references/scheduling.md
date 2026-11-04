# 相依派工與角色續辦

由目前對話按中書方案、門下決定與尚書派工表操作；使用者不需要新增手動命令。這些工具不另建任務狀態機、不常駐、不輪詢，也不代替角色作決策。

## 工作單位與放行

每單位列出：scope ID、成果、角色、讀取／寫入範圍、真正前置、驗收與共同介面。門下逐單位決定通過／退回。共同介面、權限或安全前提未齊時相關單位不得先做；真正獨立且已通過的部分可先做。

維護一份本 Run 的派工 JSON，每次收到事件由主對話核對實際成果、門下與刑部結論後更新。只納入已放行的工作，執行中工作也保留，以便讀寫衝突判斷。不要預先宣告未完成驗收已通過，也不要未讀退回結果就重用舊 JSON。**Task completed／ready 只代表 Orca 工作流程狀態，不代表方案通過或產出驗收通過。**

## 工作樹選擇

工作是否受 Run 監督與工作樹是否有父層是兩個不同關係。使用 worker-start 仍須選對工作位置，不能因為是受派代理就假設工作樹會自動成為協調者的子層。

| 情況 | worktree | 工作位置 |
| --- | --- | --- |
| 一般派工；唯讀或讀寫範圍不衝突 | current（預設） | 協調者目前工作樹內的新代理 |
| 真正需要隔離平行編輯 | new-child | 協調者目前工作樹底下的子工作樹 |
| 使用者明確要求獨立工作樹 | new-top-level | 專案下的獨立工作樹 |

同一執行主機與同專案建立子工作樹時，省略 repo，由 Orca 解析呼叫者專案與父工作樹；name 可省略。使用 --name 時，同批名稱不可重複。獨立工作樹需明確提供 repo 與 name，不以它代替不支援的子工作樹。

```sh
edict dispatch bingbu --session <本對話ID> --run <RunID> --task <TaskID> --worktree new-child --name edict-bingbu
```

new-child 的可用條件與跨主機放置須核對執行主機的 Orca placement 指南；不支援時回報限制，不默默改成 new-top-level。資料夾工作區不能直接建立 Git 子工作樹，不為此自行 git init。未指定隔離需求時維持 current。

## 建立原生 Task

先以 Orca run-create 建立本次目標的 Run。用工具寫 UTF-8 任務檔，包含角色工作範圍、前置成果與驗收；CLI 將角色與安全指令加入 Task spec：

```sh
edict task-create bingbu --session <本對話ID> --run <RunID> --spec-file /tmp/api-spec.txt --title 登入API
edict task-create xingbu --session <本對話ID> --run <RunID> --spec-file /tmp/api-check.txt --deps '["<API-TaskID>"]' --title 登入API驗收
```

deps 是原生 Task ID 陣列，不是角色名。先建立前置再使用收據 ID 建後續；不要重複建立。parent 可保存原生父任務關係。Edict 只記錄 Task／角色／Run 索引，狀態與依賴由 Orca 管理。單項啟動可用 `edict dispatch <角色> --task <ID> --run <RunID> --session <本對話ID>`，只接受本對話已保存且角色／Run 相符的 Task。

## 一次派出已就緒工作

已核對門下放行的示例資料（所有識別碼換成實際收據）：

```json
{
  "run": "run_actual",
  "tasks": [
    {
      "task": "task_frontend",
      "role": "bingbu",
      "scope": "login-frontend",
      "readOnly": false,
      "reads": ["src/contracts"],
      "writes": ["src/frontend"],
      "approval": {
        "dispatchId": "ctx_actual_menxia",
        "verdict": "approved",
        "scopes": ["login-frontend"]
      }
    },
    {
      "task": "task_backend",
      "role": "bingbu",
      "scope": "login-backend",
      "readOnly": false,
      "reads": ["src/contracts"],
      "writes": ["src/backend"],
      "approval": {
        "dispatchId": "ctx_actual_menxia",
        "verdict": "approved",
        "scopes": ["login-backend"]
      }
    }
  ]
}
```

```sh
edict dispatch-ready --session <本對話ID> --plan-file /tmp/approved-work.json --concurrency 3 --dry-run
edict dispatch-ready --session <本對話ID> --plan-file /tmp/approved-work.json --concurrency 3
```

每次呼叫只查一次 Task 清單與一次 ready 清單，按本次 Run 容量與範圍選出工作，再並行發出 worker-start。concurrency 是本工具計算的 Run 併發上限，預設 3、接受 1–8；已 dispatched 的 Task 會占名額。不是對其他協調者或直接使用原生命令的硬性全域限制，Orca 仍負責最終啟動檢查。收據在本程序逐筆保存，不把共享狀態檔交給多個獨立 CLI 同時覆寫。

readOnly 指工作樹讀寫範圍，不阻止正常寫入任務指定的獨立暫存成果。reads 預設 `['*']`，未宣告範圍視為可能讀全部；唯讀的 writes 必須為空，寫入工作必須列 writes。路徑是工作樹相對路徑，可列檔案／目錄，只有單獨的 `*` 表示全域，不支援 glob。兩個唯讀工作可並行；寫入與其他讀寫重疊會暫緩。共用來源的報告／測試須等待相關寫入完成，不能讀正在改動的檔案作驗收。

工具先透過 Orca worktree show 解析現有選擇器的真實工作樹路徑，再核對檔案／父目錄的 device、inode 與實體路徑，涵蓋符號連結、硬連結及既有大小寫別名；尚未存在的名稱以既有父目錄與保守大小寫比對處理。目錄範圍會檢查其後代連結，單一範圍組最多處理 2048 個項目，超過、權限不足、循環連結或根路徑不明時視為未知；未知範圍不會與可能衝突的讀寫工作並行。`*` 也保守視為未知的完整範圍。

尚未建立的 new-top-level／new-child 無法預先確認實體範圍，因此寫入工作保守排程。要平行修改同名路徑，先依上述工作樹選擇用 Orca 建立子工作樹，再於派工表提供 path: 或其他可解析的既有選擇器。未知範圍的現有 dispatched Task 會阻擋新候選，直到主對話補足範圍或任務完成。新工作樹基準須包含前置成果；不擅自 commit 或整合未授權變更。範圍檢查不是 OS 檔案鎖，其他程序或工作改變連結／路徑時必須重新核對，不能藉連結改動越出核准範圍。

派工前另核對專案對瀏覽器、測試服務、硬體及其他共用工具的互斥要求。檔案範圍獨立不代表工具也可同時操作；必要時加原生 Task 相依或分批列入本次核可派工檔。此工具不提供通用硬體或工具鎖。

approval 是主對話依真實門下結論填入的聲明。工具檢查門下 Dispatch 屬於本對話同 Run、scope 明列通過，以及角色／Task 索引；**不解析自然語言結論，也不驗證聲明的真實性**。主對話有責任讀完回覆後才填入，不能把退回或缺少證據當成通過。

結果列出已啟動、暫緩原因、原始 stdout／stderr 與必要的收據備份。一項失敗不抹掉其他已接受派工，也不取消、不重派。單項與批次啟動都必須取得有效的 Task／Dispatch／Run 綁定；缺少或與指定 Task／Run 不符時回報未確認並保存收據，不能因索引未寫入就重新派工。處理所有收據的 next 後結束本輪，由 Orca 喚醒；收到下一個事件再單次呼叫，不使用等待迴圈或背景掃描。

## 同角色續辦與增量彙整

```sh
edict continue <原中書DispatchID> --session <本對話ID> --spec-file /tmp/revision-delta.txt
edict continue <原門下DispatchID> --session <本對話ID> --spec-file /tmp/review-delta.txt
edict continue <原尚書DispatchID> --session <本對話ID> --spec-file /tmp/available-results.txt
```

CLI 只接受本對話收據中的 Dispatch，保留原角色與原 Run，即使本對話目前已切換其他 Run。內容經 argv 傳給原生 send，不直接拼接 shell。send 若在活躍代理中傳入訊息，保存 message ID；若原生收據建立新 Task／Dispatch，保存續辦關係與新索引。是否重啟由 Orca 決定；不傳新的模型參數。角色／模型要改變時，明確另建工作，不假裝續辦會切換模型。

同一收件批次的成果合併交給尚書；不要每個檔案都觸發完整彙整。尚書先處理可確認部分，刑部先驗可獨立成果。最後仍須等待全部必要成果及共同整合驗收，不能把暫定彙整當成最終結論。程式支援這些交接與並行操作，完整流程仍依賴協調者讀取結果並遵守角色判定。
