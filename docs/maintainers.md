# 儲存庫維護指南

此文件定義儲存庫檔案與遠端設定的維護方式。檔案進入 main 後才成為 GitHub 的預設入口；本機新增範本不代表 GitHub 設定已套用。

## 文件與社群入口

| 檔案 | 用途 |
| --- | --- |
| README.md、docs/README.md | 專案說明、架構、首次使用與文件入口 |
| CONTRIBUTING.md、.github/pull_request_template.md | 貢獻步驟、驗證、PR 範圍與限制 |
| .github/ISSUE_TEMPLATE/ | 錯誤、功能提案及使用問題；保留空白議題入口 |
| SECURITY.md、CODE_OF_CONDUCT.md | 安全漏洞與社群互動處理方式 |
| .github/CODEOWNERS、.github/dependabot.yml | 擁有者審查路由、每月 GitHub Actions 依賴更新 PR |

CODEOWNERS 不會自動要求批准；需要強制審查時須另設 branch rules。Dependabot 只提出更新，不自動合併。專案不因經過時間就自動關閉未處理議題。

## GitHub 設定目標

[repository-settings.json](repository-settings.json) 保存這次整理的明確設定值，供管理員確認及套用，不是 GitHub 自動讀取的設定檔。需先核對當前遠端設定，避免覆蓋其他維護者的修改。

| 設定 | 目標 |
| --- | --- |
| About | 使用 JSON 中的 description、homepage 及 topics，描述 Orca 三省六部、多代理與 CLI |
| 合併方式 | 允許 merge commit，關閉 squash／rebase；主工作樹合併使用 `--no-ff` |
| 私密安全回報 | 啟用 private vulnerability reporting，使 SECURITY.md 的私密表單可用 |
| 依賴安全 | 啟用 Dependabot alerts 及 security updates；Actions 定期更新由 dependabot.yml 管理 |
| 機密偵測 | 啟用 secret scanning 及 push protection；不自動處理既有警示 |

Issues 保持開啟，Wiki 保持停用，Discussions 保持停用。使用問題使用既有議題入口，不另設無人維護的討論區。

遠端設定須在取得本次明確授權後套用，並逐項讀回確認。權限不足或功能不可用時如實記錄，不能僅因 API 請求已送出就宣稱成功。GitHub 社群檔案完整度可用 `gh api repos/Splendent/edict-orca/community/profile` 查詢，該分數不代表程式品質或功能測試通過。

## CI 與發布

CI 由 `.github/workflows/ci.yml` 定義：Ubuntu 與 macOS 使用 Node 20／24 執行完整測試及語法檢查；Windows Node 24 執行更新器測試及語法檢查。Windows 更新器成功不等於 Windows 完整安裝或階層流程已驗證。

1. 核對工作樹內容、必要測試及審查意見，文件宣稱須有對應證據。
2. 更新版本與發布說明，標示資料格式、使用前置及未驗證範圍。
3. 以 `--no-ff` 合併 main 並推送已授權提交，等待對應 SHA 的必要 CI 成功。
4. 將 tag 與 Release 指向同一已驗證 SHA；beta 使用 prerelease。
5. 讀回公開 Release、遠端 main／tag 及工作樹狀態，確認內容一致。

不要更動既有 tag 來更新文件；文件整理可隨 main 更新，不自動建立新套件版本。修改安全政策時，必須同步核對私密回報的實際可用狀態；修改發布入口時，維持資料格式及跨對話限制的說明。

## 來源與改編界線

角色與流程改編自 [cft0808/edict](https://github.com/cft0808/edict)，來源基準及移植範圍見 [NOTICE.md](../NOTICE.md)。以原版的資訊完整度作為文件整理參考，不能把原版看板、部署、通訊整合或測試結果當成 Orca 版本已有能力。
