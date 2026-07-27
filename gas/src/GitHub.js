/**
 * GitHub.js — GitHub Actions の起動（repository_dispatch）
 *
 * 動画が届いたら 'video-uploaded'、Slackで「まとめて」と書かれたら
 * 'compile-requested' を送り、クラウド上で編集パイプラインを動かす。
 * GITHUB_REPO / GITHUB_TOKEN が未設定なら何もしない
 * （その場合は Actions の定期実行かローカルの `ytshorts pull` が拾う）。
 *
 * スクリプトプロパティ:
 *   GITHUB_REPO   例: "matrixtask/Youtube_Short_movies"
 *   GITHUB_TOKEN  repo への repository_dispatch 権限を持つ
 *                 fine-grained PAT（Contents: Read and write）
 */

function triggerGithub(eventType) {
  var repo = getProp('GITHUB_REPO');
  var token = getProp('GITHUB_TOKEN');
  if (!repo || !token) return false;
  try {
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
      },
      payload: JSON.stringify({ event_type: eventType }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code >= 300) {
      logEvent('github_error', eventType + ': ' + code + ' ' + res.getContentText().slice(0, 200));
      return false;
    }
    logEvent('github_dispatch', eventType);
    return true;
  } catch (e) {
    logEvent('github_error', eventType + ': ' + e);
    return false;
  }
}
