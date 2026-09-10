/**
 * AI.js — Astra/Claudeの共通入口。OPENAI_API_KEY登録時は既定でAstra。
 * LLM_PROVIDER=auto|openai|anthropic、OPENAI_MODEL=gpt-6-astra、
 * OPENAI_REASONING_EFFORT=medium。API失敗時に別providerへ切り替えない。
 * 既存askClaude/askClaudeJsonは互換用としてClaude.jsに維持する。
 */
function aiProvider() {
  var provider = String(getProp('LLM_PROVIDER', 'auto')).trim().toLowerCase();
  if (provider === 'auto') return String(getProp('OPENAI_API_KEY', '')).trim() ? 'openai' : 'anthropic';
  if (['openai', 'anthropic'].indexOf(provider) < 0) throw new Error('LLM_PROVIDER が不正です');
  return provider;
}

function askAI(systemPrompt, userPrompt, maxTokens) {
  if (aiProvider() === 'anthropic') return askClaude(systemPrompt, userPrompt, maxTokens);
  var key = requireProp('OPENAI_API_KEY');
  var effort = String(getProp('OPENAI_REASONING_EFFORT', 'medium'));
  if (['low', 'medium', 'high', 'xhigh', 'max'].indexOf(effort) < 0) {
    throw new Error('OPENAI_REASONING_EFFORT が不正です');
  }
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({
      model: getProp('OPENAI_MODEL', 'gpt-6-astra'),
      instructions: systemPrompt,
      input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }] }],
      reasoning: { effort: effort },
      // 推論トークンも含む上限。GASの実行時間を考慮しHTTP自動リトライはしない。
      max_output_tokens: Math.max(12000, (maxTokens || 2000) + 8000),
      store: false,
    }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    // エラー本文にキーや入力が含まれていてもLog/Slackへ漏らさない。
    logEvent('openai_error', 'HTTP ' + code);
    throw new Error('OpenAI API error HTTP ' + code);
  }
  var body = JSON.parse(res.getContentText());
  if (!body || body.status !== 'completed') throw new Error('OpenAI response was not completed');
  var chunks = [];
  (body.output || []).forEach(function (item) {
    if (item.type !== 'message') return;
    (item.content || []).forEach(function (part) {
      if (part.type === 'refusal') throw new Error('OpenAI declined this request');
      if (part.type === 'output_text') chunks.push(part.text);
    });
  });
  var text = chunks.join('\n').trim();
  if (!text) throw new Error('OpenAI response contained no output text');
  return text;
}

function askAIJson(systemPrompt, userPrompt, maxTokens) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var text = askAI(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', maxTokens);
    try {
      return parseJsonLoose(text);
    } catch (e) {
      if (attempt === 1) throw new Error('AIのJSONパースに失敗しました');
    }
  }
}
