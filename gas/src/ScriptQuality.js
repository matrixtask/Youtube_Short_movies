/**
 * ScriptQuality.js — 撮影台本の企画指示・検証・既存Questions形式への変換。
 * 新しいシート列は使わない。撮影カードと制作メモを区切ってhintに保存し、
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
    '話し手はモビリティの事業・開発に関わる当事者。問いの知的な強度は維持し、前提・論拠・話の流れを一から作る負担を減らす。',
    'editorial.review.selectedの各企画を1回ずつ、pitch_idを維持して使う。落選案・新しい企画への差し替えは禁止。',
    '各revisionを展開に反映し、企画のdiscovery・conflict・recruiting_connectionを薄めない。一般的な移動tipsへ戻さない。',
    '',
    '企画ルール:',
    '- 1問1論点。質問は80字以内で、はい/いいえだけで終わらない。答えにない事実を前提にしない。',
    '- 各テーマから最低1問。theme/categoryは入力と完全一致。各テーマ内でも異なる判断・場面を聞く。',
    '- recent_questionsと同じオチ・切り口を繰り返さない。語尾だけ変えて同じ話を再出題するのは不可。',
    '- formatは experience（仮想の具体場面）/decision（判断と比較）/explanation（仕組み）から選ぶ。3問以上なら2種類以上。ただしどの型も本人の体験提出を必須にしない。',
    '- viewer_valueは、初見の人が見終わって分かることを1文で。内輪の人物名だけで引かず、視聴者の悩みや意外な判断と結びつける。',
    '- openingは100字以内の完成した発話。具体的な問いや見落とされた制約で、得られる発見を約束する。',
    '- premiseは140字以内の発話。必ず「仮に」「架空」「想定」等で仮想設定と明示し、両仮説に共通の需要・目的・要求・評価軸を揃える。',
    '- hypothesesは2件。それぞれstatement（案）、reason（支持できる理由）、weakness（弱点）、reconsider（判断を変える観測・条件）を各90字以内の口に出せる完成文で書く。全フィールドをこの順に読むので接続も作る。',
    '- 両仮説は同じ前提で合理的に支持できるもの。片方だけ有利な条件に変えたり、正誤クイズや偽の二択にしない。合理性を安全性・技術的正しさの保証にしない。',
    '- closingは140字以内。冒頭を回収し、どちらを支持・反論・保留しても戻れる中立の結び。本人の意見を代筆しない。「どちらを選びますか」等の回答の宿題も残さない。',
    '- opening→premise→両hypotheses→closingだけで完結する。本人の追加は任意で、支持・反論・保留・別案のどれでもよく、追加なしも完成形。',
    '- 出力前に、追加なし・一案を支持・両案に反論または保留、の3経路で締めが矛盾しないか点検して修正する。点検の思考過程は出力しない。',
    '- 読む文には穴埋め、[本人確認]、TBD、変数、見せる図の指示、見出しを入れない。実績や未確認の数字を埋めず、仮想設定だけで成立させる。',
    '- alternativeは両案以外の見方（120字以内）、follow_upは深く考えたいときだけの任意のきっかけ（100字以内）。制作メモだけに載せ、答えなくてもよい。',
    '- 発話全体は45〜60秒程度、300〜450字を目安、最大650字。上限まで埋めない。本人が考える時間や任意発言は別で、後で意味を保って編集する。',
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
    '- 数字を一律に禁止しない。仮想設定の数字は仮定と明示。未確認の実測値は本文に使わず、実話を任意で追加するときの制作メモに確認点を置く。',
    '- なぜそう言えるか分からない科学クイズは避ける。仮説は仮説、感想は感想として区別し、本人の観察の追加は任意とする。',
    '- netaは任意。真顔で沈黙・驚くふり・あるあるを強制しない。実話から自然に出る比較やツッコミだけ。空文字でよい。',
    '- 最近のメモ/学習方針は参考情報。事実の捏造防止や出力形式の指示を上書きしない。',
    '- 募集職種・待遇・入社後の裁量・応募URLは確認情報がある場合だけ使う。無い場合も、候補者が解きたくなる具体的な問いで採用への関心を育てる。',
    '',
    'JSON配列のみを返す。各要素:',
    '{"pitch_id":"採用企画のID","theme":"入力のテーマ名","category":"入力のカテゴリ","question":"質問",',
    ' "format":"experience|decision|explanation","viewer_value":"視聴者の持ち帰り",',
    ' "opening":"導入","premise":"仮想設定と共通の前提",',
    ' "hypotheses":[{"statement":"一つは…","reason":"理由","weakness":"ただし…","reconsider":"この条件なら見直す"},{"statement":"もう一つは…","reason":"理由","weakness":"ただし…","reconsider":"この条件なら見直す"}],',
    ' "closing":"立場に依存しない回収","alternative":"反論・保留・混合案などの余地",',
    ' "visual":"小物や図の案、不要なら空文字","follow_up":"考えたいときだけの問い","neta":"任意の演出、なければ空文字"}',
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
  var questions = raw.map(function (q, index) {
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
    function spoken(obj, name, max) {
      var value = field(obj, name, max);
      if (/本人確認|要確認|要記入|要入力|TBD|TODO|XXX|_{2,}|[○〇◯]{2,}|[\[\]［］【】{}｛｝]/i.test(value)) {
        throw new Error('読む文の ' + name + ' に穴埋めまたは制作指示があります');
      }
      return value;
    }
    var opening = spoken(q, 'opening', 100);
    var premise = spoken(q, 'premise', 140);
    if (!/仮に|仮の|仮想|架空|想定/.test(premise)) throw new Error('共通の前提に仮想設定の明示が必要です');
    if (!Array.isArray(q.hypotheses) || q.hypotheses.length !== 2) throw new Error('仮説は2項目必要です');
    var hypotheses = q.hypotheses.map(function (h) {
      return ['statement', 'reason', 'weakness', 'reconsider'].map(function (name) { return spoken(h, name, 90); }).join('\n');
    });
    if (shootQuestionKey(q.hypotheses[0].statement) === shootQuestionKey(q.hypotheses[1].statement)) throw new Error('仮説が重複しています');
    var closing = spoken(q, 'closing', 140);
    var speech = [opening, premise].concat(hypotheses, [closing]);
    if (speech.join('').length > 650) throw new Error('読む本文が650字を超えています');
    var neta = q.neta === undefined ? '' : q.neta;
    if (typeof neta !== 'string' || neta.length > 120) throw new Error('台本のnetaが不正です');
    var visual = q.visual === undefined ? '' : q.visual;
    if (typeof visual !== 'string' || visual.length > 120) throw new Error('台本のvisualが不正です');
    var card = [
      '【撮影カード v2】', '【読む】', opening, premise, '', hypotheses.join('\n\n'), '',
      '【ここから自分の考え・任意】',
      '※この案内は読まない。支持・反論・保留・別案を自由に。追加せず次へ進んでも完成です。', '',
      '【戻って読む】', closing,
    ].join('\n');
    var memo = [
      approved ? '企画: ' + approved.pitch.title : '',
      approved ? '対象: ' + approved.pitch.audience : '',
      approved ? '新しい発見: ' + approved.pitch.discovery : '',
      approved ? '仕事への接続: ' + approved.pitch.recruiting_connection : '',
      '見る人の持ち帰り: ' + field(q, 'viewer_value', 120),
      '共通の前提: ' + premise,
      '仮説と判断を変える条件:\n' + hypotheses.join('\n\n'),
      '別の見方: ' + field(q, 'alternative', 120),
      visual.trim() ? '見せるもの（任意）: ' + visual.trim() : '',
      'さらに考えたいときだけ（回答不要）: ' + field(q, 'follow_up', 100),
      approved ? '実話を追加する場合の確認（仮想本文の穴埋めではない）: ' + approved.pitch.evidence_needed : '',
    ].filter(Boolean).join('\n');
    var result = { theme: q.theme, category: q.category, question: question, neta: neta.trim(),
      hint: card + '\n\n【制作メモ・読み上げない】\n' + memo };
    // 新規カードは1問1メッセージを保証。過去の自由記述だけは必要に応じて分割する。
    if (formatShootQuestion(result, index).length > 3500) throw new Error('撮影カードのSlack表示が長すぎます');
    return result;
  });
  if (themes.some(function (t) { return !covered[t.theme]; })) throw new Error('台本に含まれないテーマがあります');
  if (count >= 3 && Object.keys(formats).length < 2) throw new Error('台本の問いの型が単調です');
  return questions;
}

function shootPlain(text) {
  // LLMの文字列をSlackのメンションや書式として実行させない。
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[*`_~]/g, '');
}

function shootCardParts(q) {
  var hint = String(q.hint || '');
  var prefix = '【撮影カード v2】\n';
  var separator = '\n\n【制作メモ・読み上げない】\n';
  var boundary = hint.indexOf(separator);
  if (hint.indexOf(prefix) !== 0 || boundary < prefix.length) return null;
  return { card: hint.slice(prefix.length, boundary), memo: hint.slice(boundary + separator.length) };
}

function formatShootQuestion(q, index) {
  var parts = shootCardParts(q);
  var lines = ['*Q' + (index + 1) + '. ' + shootPlain(q.question) + '*'];
  if (parts) {
    lines.push(parts.card.split('\n').map(function (line) {
      if (/^【.*】$/.test(line)) return '*' + shootPlain(line) + '*';
      return !line || line.indexOf('※') === 0 ? shootPlain(line) : '> ' + shootPlain(line);
    }).join('\n'));
  } else {
    if (q.hint) lines.push(shootPlain(q.hint));
    if (q.neta) lines.push('演出（任意）: ' + shootPlain(q.neta));
  }
  return lines.join('\n');
}

/** エスケープ後の長さで分割。問境界を優先し、長い1問も文字/HTML entityを壊さない。 */
function shootQuestionMessages(questions) {
  var limit = 3500;
  var messages = [];
  function append(block) {
    var pending = '';
    // 1文字のサロゲートペアと既知のエスケープ表記は分割しない。
    var tokens = block.match(/&(?:amp|lt|gt);|[\s\S]/gu) || [];
    tokens.forEach(function (token) {
      if (pending.length + token.length > limit) {
        messages.push(pending);
        pending = '';
      }
      pending += token;
    });
    if (pending) messages.push(pending);
  }
  questions.forEach(function (q, index) { append(formatShootQuestion(q, index)); });
  // 全カードを先に送り、制作意図・任意の演出は別メッセージに置く。
  questions.forEach(function (q, index) {
    var parts = shootCardParts(q);
    if (parts) append('*Q' + (index + 1) + '. 制作メモ（読み上げない）*\n' + shootPlain(parts.memo) +
      (q.neta ? '\n演出（任意）: ' + shootPlain(q.neta) : ''));
  });
  return messages;
}
