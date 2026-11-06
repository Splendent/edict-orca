# 啟用後的協調流程

本文件的業務流程只在原 session 的 `edict context --session <ID>` 回傳 active 啟用時套用。off 後仍可按原委派保存收據及傳送受限的唯讀 report，不因此恢復業務。保留原對話為 root，不另開主對話；一般問答與解釋直接回答，不建立 Run。先讀專案規則、使用者授權與本機 Orca `skills get orchestration` 的版本對應指南。

session 與 Run 是不同識別。每個新獨立目標由原對話執行 `run open --objective`，保留回傳 id；其他內部命令明確帶 `--run`，不能猜目前最後一個 Run。所有角色沿用同一 EDICT_HOME 與 session，但原生身分分開。知道 session 或 member ID 不代表具有頭領權限。

## 開始工作

以下五個階段是角色流程，使用者不需手動逐次轉交。具體 JSON 與命令見 [工作契約](workflow.md)。

1. root 建立需求項目前，先 `work show` 與所有在途及排隊項目比對 reads、writes、resources 與相依。`work show` 只列一個 Run，而派工衝突檢查涵蓋本機所有 Run 的在途操作，因此每個仍有在途工作的 Run 都要分別 `work show` 核對。沒有實際讀寫重疊時，為新項目選用不同的資源名稱（例如另一個 port）或工作樹，不沿用其他項目的互斥資源；有重疊或真正相依時才排隊。建立後先告訴使用者並行或排隊的決定與原因，例如「W-015 與 W-013 檔案不重疊，改用 vite-5217，可並行；W-014 需等 W-013 結案」。已建立的項目只差資源或需要更多讀取範圍時，用 `work amend` 修訂需求的 resources，或擴大 reads／extraReads，不取消重建；writes 不能修訂。需要讀取其他工作樹時以 extraReads 宣告；會 commit 或 merge 的工作在 resources 宣告 `git:<common dir>`，詳見工作契約。root 建立需求項目及三省平行頭領：無 work 的 `team ensure zhongshu`、`team ensure menxia`、`team ensure shangshu`。中書 scope 為 `*`；門下與尚書先為空 scope，只等待合法業務，不審查、不派實作。
2. 中書拆分真正獨立項目，必要時 `delegate zhongshu` 交舍人調查。中書頭領以 `work plan` 保存方案，方案須含並行分析（與每個在途及排隊項目的比對及「可並行」或「需排隊」結論），然後 `team ensure menxia --work` 授予既有門下該項目，`team send` 送審。重複 ensure 不另開同一角色頭領，grant 也不自動喚醒。
3. 門下頭領依原始需求、方案、並行分析、證據及驗收，以 `review record` 保存 plan-approval；給事中可分工審查，但不能代替頭領的正式放行。退回交中書修正；三輪仍未通過回報具體缺口，不強制批准。
4. 核可後由中書或門下 `team ensure shangshu --work` 授予既有尚書工作，再 `team send`。尚書建立相關六部頭領，各部頭領自行 `delegate` 本部 executor。無關工作可先進行；共同介面與真正前置未齊者等待，不重建 Task 取代等待。
5. implementation executor 提交實際成果；刑部獨立驗收，尚書核對必要整合與需求覆蓋。`sync` 確認原生實作已成功結束、成果到齊，再由門下保存 closure-confirmation。只有門下合法確認才為 Done；結案後以 kind=report 向既有頭領傳送完成結果，尚書交中書核對，root 據此回報使用者。

root 建立三省是控制啟動，不代替送審或核可。三省的原生 creator 都是 root，避免「中書 → 尚書 → 部 → 郎中」多增加一層；尚書管理部尚書，部尚書管理郎中，仍需原生深度 3。由使用者在 Settings → Orchestration → Nested worker depth 確認，不自行改設定。

## 分工與交接

每次委派以 JSON 的 `title` 寫明該執行代理的具體子工作，例如「冰霜特效原生格比對」；不要只填「處理任務」。分頁名稱使用職位、工作、直接上級與成員短碼。已確認原生派工後才處理顯示；顯示或改名失敗不重派工作。缺少可見版面的終端會先顯示既有分頁，再返回呼叫者；共用分頁只改該代理面板。

使用者問派工進度或有哪些下屬時，按已知 Run `sync` 核對原生狀態，再將 `status`／`work show` 的 `hierarchy` 轉成完整派工樹。逐層列頭領及所有下屬的 assignment、workerState、worktree 與可定位的 Dispatch；跨工作樹及結果未確認的下屬也須列出，不能只報頭領或一項工程進度。`observedAt` 是最後同步時間；未同步或為 null 不得改稱正在執行。額外保留 presentation 的不可見、未確認及返回分頁警告。

同一工作項目的每份 plan、review、帶 work 的 ensure／delegate／team send 都明確帶目前 `generation`。新增項目從 1 開始；取消後明確重做才產生新代，不把 revision 當 generation。`work result` 以原 operation ID 綁定其世代，JSON 可附 generation 供交付說明，但不能用它改變原委派。

六部跨部門問題交尚書轉送，不能直接命令其他部門。執行代理只向自己的頭領回報／提問，不再開下層。正式訊息用 `team send <目標memberId>`；目標原生身分已 settled 且回應 owner-required 時，原對話用 `team forward <messageId>` 原樣代送，不重寫決策。完整規則見 [執行與恢復](scheduling.md)。

team send 的 JSON 預設 kind=handoff，代表受控制及授權限制的業務交接。完成或停止結果用 `{"generation":1,"kind":"report","body":"W-001 已完成門下結案，成果與驗收摘要見目前 work show。"}`。report 只許頭領間沿既有合法路由及共同 scope 回報，仍核對身分與世代；可在 Done、pause、cancel 或 off 後保存及轉達唯讀結果，但不授權實作、不改核可、不送 executor，也不藉通知要求對方恢復派工。

方案修改會更換摘要並使舊核可失效；成果或證據檔案改變會使相關驗收失效。只重審受影響部分，不能沿用作者自述的通過。頭領核對覆蓋、介面、風險及缺口，不要求每位頭領重做全部實作或測試。

## 事件、進度與收尾

啟動本階段所有有權且不衝突的工作後結束當輪，讓 Orca 在回報時喚醒。結束當輪不等於整體工作完成。依原生前言處理 ask／reply／worker_done；子工作仍在執行時，頭領不得以 worker_done 宣告整項交付完成。

收到原生事件或使用者詢問進度時，單次 `sync --run` 核對原生執行、停止要求與工作視圖；需要原生郵件時按本機指南處理，不能輪詢、sleep 或開常駐消費程序。喚醒延後或暫時無輸出不證明代理停止。

保留成果原文、原生收據及待決問題。讀 `work show` 取得項目的狀態、generation、plan／result digest、members、operations、decisions 及 messages；不要只看 session 的舊索引。狀態為 Review 不代表核可，原生成功也不代表 Done。

使用者可明確要求暫停、恢復或取消。root 執行相應 `control`；off 禁止新派工及業務推進，但已有委派可完成並保存回報。控制回覆仍可能有在途請求，列出未知與仍執行的工作，不宣稱程序全部凍結。取消與重做詳見 scheduling.md。

不自行 commit、merge、push、發布、部署或傳送外部內容；這些沿用使用者與專案的明確授權。輸出證據先清除 token、密碼及金鑰。缺少資訊先在可讀範圍查證；會改變需求取捨或授權的事項由頭領升級原對話詢問。

## 執行範圍

v2 工作政策已有模擬測試，但完整多層原生流程、各供應商、控制交錯與壓縮恢復未全測。doctor 不提供這些認證；缺能力時如實回報，不能把設計文件中的目標功能當作現行介面。舊 v1 資料與免核可派工入口不支援，保留原資料，使用新狀態驗證。
