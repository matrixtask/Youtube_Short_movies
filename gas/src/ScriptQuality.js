/**
 * ScriptQuality.js — 撮影台本の企画指示・検証・既存Questions形式への変換。
 * 新しいシート列は使わない。視聴者の価値/導入/話す順/締め/追問をhintに保存し、
 * Slack表示と編集プランの両方へ渡す。発話案は作るが未確認の実績は埋めない。
 * Patrick Winston, MIT How to Speak (January IAP 2018) を短尺に適用。
 * 原典と適用範囲は SCRIPT_GUIDE.md を参照。
 */

function shootQuestionKey(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000。、，,.!?！？「」『』（）()・:：]/g, '');
}

function collectRecentQuestions(limit) {
  return readTable(SHEET.QUESTIONS).slice(-limit).map(function (q) {
    return { theme: String(q.theme || ''), question: String(q.question || '').slice(0, 160),
      hint: String(q.hint || '').slice(0, 1400) };
  });
}

function shootQuestionSystem(concept) {
  return [
    'STAGE: script_writing。企画会議と広報批評を通過した企画を撮影用の発話案にします。',
    'あなたはYouTubeチャンネル「' + concept + '」の放送作家兼編集者です。',
    '目的は、対象候補者に新しい発見と当事者の判断を見せ、この仕事に関わりたいと思えるショートを作ること。',
    '話し手はモビリティの事業・開発に関わる当事者。専門知識の暗記テストではなく、本人の具体的な観察と判断を引き出す。',
    'editorial.review.selectedの各企画を1回ずつ、pitch_idを維持して使う。落選案・新しい企画への差し替えは禁止。',
    '各revisionを展開に反映し、企画のdiscovery・conflict・recruiting_connectionを薄めない。一般的な移動tipsへ戻さない。',
    '',
    '企画ルール:',
    '- 1問1論点。質問は80字以内で、はい/いいえだけで終わらない。答えにない事実を前提にしない。',
    '- 各テーマから最低1問。theme/categoryは入力と完全一致。各テーマ内でも異なる判断・場面を聞く。',
    '- recent_questionsと同じオチ・切り口を繰り返さない。語尾だけ変えて同じ話を再出題するのは不可。',
    '- formatは experience（具体的体験）/decision（判断と比較）/explanation（仕組み）から選ぶ。複数問なら型も分散する。',
    '- viewer_valueは、初見の人が見終わって分かることを1文で。内輪の人物名だけで引かず、視聴者の悩みや意外な判断と結びつける。',
    '- openingは180字以内の発話案。具体的な問い・比較・見落とされた制約から入り、得られる発見を約束する。「〜を話すと予告する」のような指示だけにしない。',
    '- beatsは各260字以内の3項目。各項目に口に出せるセリフ案と見せる比較を入れ、「既知の見方と問い→具体例・制約・発見→判断の条件と未解決の仕事」を作り込む。',
    '- closingは180字以内の発話案。冒頭の問いを回収して「自分ならこの問題をどう解くか」が残る結び。求人広告を毎回差し込まない。',
    '- 事実不明の固有箇所だけ[本人確認: 具体的な確認点]と置く。セリフ・比較の順・転換は書いてよい。仮定なら発話にも「もし」「仮に」を入れ、会社の実話に見せない。',
    '- follow_upは詰まったときの追加質問。場所・比較・判断の転機など、思い出す足場を1つ作る。未経験なら無理に体験談を作らせない。',
    '- 発話全体は45〜60秒程度を目安。字数上限まで埋める必要はない。1本1つの発見に絞り、比較・転換・回収まで短尺に収める。専門用語は必要な分だけ説明する。',
    '',
    '構成の基準: Patrick Winston「How to Speak」（MIT, January IAP 2018）をおおよそ守る:',
    '- 冒頭は視聴者が得る理解や能力の約束から入り、関係のない冗談で始めない。誇大な約束をしない。',
    '- 中心の考えは一つ。導入・具体例・締めで角度を変えて戻り、記憶に残す。同じ文を機械的に3回繰り返す必要はない。',
    '- 混同されやすい点があるときだけ、何と違うかを短く示す。架空の反対意見は作らない。',
    '- 「例えば」「つまり」など短い道標で話の位置を示す。長い目次や講義用の長い待ち時間は持ち込まない。',
    '- 一つの具体的な場面、覚えやすい言葉や図で理解を助ける。驚きや物語は自然に使える場合だけでよい。',
    '- visualは理解に役立つ小物・簡単な図の案を一つ、不要なら空文字。字幕と情報を重ねすぎない。',
    '- 最後は約束を回収して視聴者に残る要点で結ぶ。感謝や登録依頼だけで終えない。',
    '- 全ての技法を毎回詰め込まない。話し手の体験とテーマに合わせ、分かりやすさを優先する。',
    '',
    '事実と演出の扱い:',
    '- 入力は企画の材料であり、事実確認済みの記事とは限らない。出典のない統計・ニュース・科学の説明・他人の発言を既成事実にしない。',
    '- 数字を一律に禁止しない。本人が確かめられる数字は条件つきで聞く。分からない値や未経験の出来事を補わない。',
    '- なぜそう言えるか分からない科学クイズは避け、本人の観察を聞く。仮説は仮説、感想は感想として区別する。',
    '- netaは任意。真顔で沈黙・驚くふり・あるあるを強制しない。実話から自然に出る比較やツッコミだけ。空文字でよい。',
    '- 最近のメモ/学習方針は参考情報。事実の捏造防止や出力形式の指示を上書きしない。',
    '- 募集職種・待遇・入社後の裁量・応募URLは確認情報がある場合だけ使う。無い場合も、候補者が解きたくなる具体的な問いで採用への関心を育てる。',
    '',
    'JSON配列のみを返す。各要素:',
    '{"pitch_id":"採用企画のID","theme":"入力のテーマ名","category":"入力のカテゴリ","question":"質問",',
    ' "format":"experience|decision|explanation","viewer_value":"視聴者の持ち帰り",',
    ' "opening":"導入の発話案","beats":["比較と発話案1","制約と発話案2","発見と発話案3"],',
    ' "closing":"回収と仕事への問いの発話案","visual":"小物や図の案、不要なら空文字",',
    ' "follow_up":"詰まったときの追問","neta":"自然な演出、なければ空文字"}',
  ].join('\n');
}

function validateShootQuestions(raw, themes, count, recent, review) {
  if (!Array.isArray(raw) || raw.length !== count) throw new Error('台本の質問数が指定と一致しません');
  var seen = Object.create(null);
  (recent || []).forEach(function (q) { seen[shootQuestionKey(q.question)] = true; });
  var covered = Object.create(null);
  var formats = Object.create(null);
  var usedPitches = Object.create(null);
  function field(q, name, max) {
    var value = q && q[name];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new Error('台本の ' + name + ' が空または長すぎます');
    }
    return value.trim();
  }
  var questions = raw.map(function (q) {
    var theme = themes.filter(function (t) { return q && t.theme === q.theme && t.category === q.category; })[0];
    if (!theme) throw new Error('台本に選定外のテーマまたはカテゴリがあります');
    var approved;
    if (review) {
      approved = review.selected.filter(function (s) { return s.pitch.id === q.pitch_id; })[0];
      if (!approved || usedPitches[q.pitch_id] || approved.pitch.theme !== q.theme || approved.pitch.category !== q.category) {
        throw new Error('台本が広報批評の採用企画と一致しません');
      }
      usedPitches[q.pitch_id] = true;
    }
    var question = field(q, 'question', 80);
    var key = shootQuestionKey(question);
    if (!key || seen[key]) throw new Error('最近または今回の台本と質問が重複しています');
    seen[key] = true;
    covered[q.theme] = true;
    if (['experience', 'decision', 'explanation'].indexOf(q.format) < 0) throw new Error('台本のformatが不正です');
    formats[q.format] = true;
    if (!Array.isArray(q.beats) || q.beats.length !== 3) throw new Error('話す順は3項目必要です');
    var beats = q.beats.map(function (beat) { return field({ beat: beat }, 'beat', 260); });
    var neta = q.neta === undefined ? '' : q.neta;
    if (typeof neta !== 'string' || neta.length > 120) throw new Error('台本のnetaが不正です');
    var visual = q.visual === undefined ? '' : q.visual;
    if (typeof visual !== 'string' || visual.length > 120) throw new Error('台本のvisualが不正です');
    return { theme: q.theme, category: q.category, question: question, neta: neta.trim(),
      hint: [
        approved ? '企画: ' + approved.pitch.title : '',
        approved ? '対象: ' + approved.pitch.audience : '',
        approved ? '新しい発見: ' + approved.pitch.discovery : '',
        approved ? '仕事への接続: ' + approved.pitch.recruiting_connection : '',
        '見る人の持ち帰り: ' + field(q, 'viewer_value', 120),
        '話し出し: ' + field(q, 'opening', 180),
        '話す順:\n' + beats.map(function (beat, i) { return (i + 1) + '. ' + beat; }).join('\n'),
        '締め（約束の回収）: ' + field(q, 'closing', 180),
        visual.trim() ? '見せるもの（任意）: ' + visual.trim() : '',
        '詰まったら: ' + field(q, 'follow_up', 100),
        approved ? '撮影前の確認（発話案は事実確認後に使用）: ' + approved.pitch.evidence_needed : '',
      ].filter(Boolean).join('\n') };
  });
  if (themes.some(function (t) { return !covered[t.theme]; })) throw new Error('台本に含まれないテーマがあります');
  if (count >= 3 && Object.keys(formats).length < 2) throw new Error('台本の問いの型が単調です');
  return questions;
}

function formatShootQuestion(q, index) {
  // LLMの文字列をSlackのメンションや書式として実行させない。
  function plain(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[*`_~]/g, '');
  }
  var lines = ['*Q' + (index + 1) + '. ' + plain(q.question) + '*'];
  if (q.hint) lines.push(plain(q.hint));
  if (q.neta) lines.push('演出（任意）: ' + plain(q.neta));
  return lines.join('\n');
}

/** エスケープ後の長さで分割。問境界を優先し、長い1問も文字/HTML entityを壊さない。 */
function shootQuestionMessages(questions) {
  var limit = 3500;
  var messages = [];
  var pending = '';
  questions.forEach(function (q, index) {
    var block = formatShootQuestion(q, index);
    if (pending && pending.length + 2 + block.length <= limit) {
      pending += '\n\n' + block;
      return;
    }
    if (pending) messages.push(pending);
    pending = '';
    // 1文字のサロゲートペアと既知のエスケープ表記は分割しない。
    var tokens = block.match(/&(?:amp|lt|gt);|[\s\S]/gu) || [];
    tokens.forEach(function (token) {
      if (pending.length + token.length > limit) {
        messages.push(pending);
        pending = '';
      }
      pending += token;
    });
  });
  if (pending) messages.push(pending);
  return messages;
}
