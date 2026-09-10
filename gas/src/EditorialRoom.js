/**
 * EditorialRoom.js — 3者の企画会議 → 架空の広報責任者による批評。
 * 同一モデルが演じる架空の編集視点。独立した専門家・実在の広報担当ではない。
 * 長い思考過程ではなく、企画・異論・修正指示をJSONで受け渡す。
 * 既存Questions列を維持。通過企画と短い講評はhint/Logへ残す。
 */

function recruitingContext() {
  return {
    audience: getProp('SCRIPT_AUDIENCE', '航空分野に限らず、難しい開発に参加したい技術者。一般的な効率化の話は既に知っている'),
    context: getProp('RECRUITING_CONTEXT', 'モビリティの開発・事業に関わる仕事への関心を育てる。募集職種、待遇、裁量、応募URLは未確認'),
    goal: '新しい発見と当事者の判断を通じて、この仕事を自分ならどう解くか考えたくなること。再生数や撮影成立数を採用成果と同一視しない',
  };
}

function editorialText(obj, name, max) {
  var value = obj && obj[name];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error('編集会議の ' + name + ' が空または長すぎます');
  }
  return value.trim();
}

function editorialDiscussionSystem() {
  return [
    'STAGE: editorial_discussion。撮影前の企画会議です。まだ台本を書かないでください。',
    '以下の架空の3人が異論を出し合い、他者の反論を受けて企画を改善してください。実在専門家の検証ではありません。',
    'rei（レイ）: 技術・具体性・証拠。共通の前提と評価軸で仮説を比べる。「誰でも知っている説明」「中身のない逆張り」を退ける。',
    'sebastian（セバスチャン）: 候補者の信頼と話し手の負担。実話の提出や穴埋めなしで話が完結するか。待遇・職種・権限を捏造しない。',
    'hannibal（ハンニバル）: 一度の敗北を徹底して内省し転生した架空の軍師。外部投資家・メンターの視点も持つ。局地の勝利と最終目的を分け、資源・補給・時間・組織・協力者・相手の適応・持続性から、判断を変える条件や撤退条件を問う。勝利を保証しない。',
    '各人のobjectionは他の視点への具体的な異論、revisionはそれを受けた改善案を短く。賛同3件だけでは不可。',
    '出力するのは短い編集講評と結論だけ。逐語の思考過程や長い討論記録は不要。',
    '指定のpitch_count件の候補を比較可能にする。各theme/categoryは入力と一致し、各テーマを最低1案含める。',
    'テーマ名は素材の分類。通勤や移動tipsでも、観察から設計・事業の制約や仕事の判断へ掘り下げる。',
    '「早めに確認する」「自分に合う経路」「便利なコツ」だけで終わる企画は不採用。会社名を足しただけでも不可。',
    'audienceの既知の見方から何が新しく分かるかをdiscoveryに書く。誇大な断言や必ず逆転する物語は不要。',
    'conflictは比較・見えにくい制約・判断を変える条件のどれか。developmentは具体物、比較、転換、回収まで作る。',
    '問いの知的な強度を保つ。下げるのは準備と構成の負担。難しい問いを日常tipsや簡単な二択へ置き換えない。',
    'developmentには共通の前提、二つの合理的な仮説、各案の理由・弱点・判断を変える条件を準備する。片方だけ条件を変えず、反論・保留・別案の余地を残す。',
    '仮想設定の説明だけで撮影が完結する企画にする。本人の追加発言は任意。evidence_neededは実話を追加したい場合の確認事項であり、本文の穴埋めや回答の宿題にしない。',
    'recruiting_connectionはこの題材から見える具体的な仕事や未解決の問い。「仲間募集」「会社の魅力」だけでは不足。',
    '事実不足ならevidence_neededに[本人確認: 必要な事実]。架空の実績は作らず、仮説の比較なら仮説と明示する。',
    'recent_questionsと同じ切り口・オチは避ける。入力のメモや過去の学習にある衝撃数字・会社話低頻度は本方針より優先しない。',
    'JSONのみ: {"perspectives":[{"role":"rei","objection":"異論","revision":"改善案"},',
    '{"role":"sebastian","objection":"異論","revision":"改善案"},{"role":"hannibal","objection":"異論","revision":"改善案"}],',
    '"resolution":"合意と残す対立（200字以内）","pitches":[{"id":"p1","theme":"入力名","category":"入力値",',
    '"title":"動画の企画名（80字以内）","audience":"想定候補者（120字以内）","discovery":"新しい発見（160字以内）",',
    '"conflict":"判断を生む制約（160字以内）","development":"比較から回収までの展開（240字以内）",',
    '"evidence_needed":"撮影前に確認する点（200字以内）","recruiting_connection":"仕事への接続（160字以内）"}]}',
    '各objection/revisionは160字以内。',
  ].join('\n');
}

function validateEditorialDiscussion(raw, themes, pitchCount) {
  if (!raw || !Array.isArray(raw.perspectives) || raw.perspectives.length !== 3 ||
      !Array.isArray(raw.pitches) || raw.pitches.length !== pitchCount) throw new Error('編集会議の3視点または企画数が不正です');
  var roles = ['rei', 'sebastian', 'hannibal'];
  var perspectives = roles.map(function (role) {
    var matches = raw.perspectives.filter(function (p) { return p && p.role === role; });
    if (matches.length !== 1) throw new Error('編集会議の視点が重複または欠落しています');
    return { role: role, objection: editorialText(matches[0], 'objection', 160), revision: editorialText(matches[0], 'revision', 160) };
  });
  var seen = Object.create(null);
  var titles = Object.create(null);
  var pitches = raw.pitches.map(function (p) {
    var id = editorialText(p, 'id', 24);
    if (!/^p[1-9][0-9]*$/.test(id) || seen[id]) throw new Error('編集会議の企画IDが不正または重複しています');
    seen[id] = true;
    if (!themes.some(function (t) { return t.theme === p.theme && t.category === p.category; })) throw new Error('編集会議に選定外テーマがあります');
    var title = editorialText(p, 'title', 80);
    var titleKey = shootQuestionKey(title);
    if (!titleKey || titles[titleKey]) throw new Error('編集会議の企画名が重複しています');
    titles[titleKey] = true;
    return { id: id, theme: p.theme, category: p.category, title: title,
      audience: editorialText(p, 'audience', 120), discovery: editorialText(p, 'discovery', 160),
      conflict: editorialText(p, 'conflict', 160), development: editorialText(p, 'development', 240),
      evidence_needed: editorialText(p, 'evidence_needed', 200),
      recruiting_connection: editorialText(p, 'recruiting_connection', 160) };
  });
  if (themes.some(function (t) { return !pitches.some(function (p) { return t.theme === p.theme; }); })) throw new Error('編集会議に含まれないテーマがあります');
  return { perspectives: perspectives, resolution: editorialText(raw, 'resolution', 200), pitches: pitches };
}

function editorialReviewSystem() {
  return [
    'STAGE: editorial_pr_review。ミアとして、企画会議を批評してください。',
    'ミアは以前の「イーロンの広報担当」役を引き継ぐ架空の広報・クリエイティブ責任者です。実在の人物の見解・所属・承認を装わない。',
    '会議の結論にも異議を唱え、「この人が話す理由」「視聴者の発見」「解きたくなる仕事」が弱い候補は落とす。',
    '自分の批評も点検する。煽りだけ、偽の逆張り、英雄礼賛、裏付けのない成功物語にしていないかを見直す。',
    '出力は短いcritiqueと具体的な採否・修正指示のみ。隠れた思考過程は不要。まだ台本は書かない。',
    'count件だけ採用。各テーマを最低1件。候補を修正してよいが、元のテーマと論点を維持する。',
    'novelty/specificity/recruiting/depth/speakability/clarityを各1〜5で別々に採点。各4以上が合格。単に採用数を満たすために採点を上げない。',
    'novelty=対象候補者に新しい具体的発見、specificity=固有の比較や検証可能な問い、recruiting=具体的な仕事への関心。',
    'depth=共通の前提で理由・弱点・判断変更条件まで掘れる、speakability=仮想説明だけで完結し本人の回答や実話提出を必須にしない、clarity=読む本文と任意発言と制作メモを分けられる。',
    'reasonには6軸の評価根拠を短く。revisionには前提の不公平、偽の二択、本人の立場の代筆、隠れた宿題を除く具体的な改善を示す。',
    '話しやすさのために問いを易しくしたなら不合格。反論・保留・別案を認め、追加なしでも結びが成立するか点検する。',
    '確認情報が足りない場合は事実を捏造せず、共通の仮想設定で比較を成立させる。採点は企画のモデル評価であり、完成台本や実際の面白さの保証ではない。',
    '改善しても合格する案が足りなければselectedは足りないまま返し、critiqueに不足素材を記す。無難な台本で埋めない。',
    '採らなかった全候補はrejectedにIDと理由を記録。',
    'JSONのみ: {"critique":"会議への批評と自身の修正（240字以内）","selected":[{"pitch_id":"p1",',
    '"novelty":4,"specificity":4,"recruiting":4,"depth":4,"speakability":4,"clarity":4,"reason":"6軸の評価根拠（240字以内）","revision":"作り込む展開（240字以内）"}],',
    '"rejected":[{"pitch_id":"p2","reason":"不採用理由（160字以内）"}]}',
  ].join('\n');
}

function validateEditorialReview(raw, discussion, themes, count) {
  if (!raw || !Array.isArray(raw.selected) || raw.selected.length !== count || !Array.isArray(raw.rejected)) {
    throw new Error('広報批評で合格企画が不足しています。具体的な開発判断や比較材料をメモに追加してください');
  }
  var seen = Object.create(null);
  function findPitch(item) {
    var pitch = item && discussion.pitches.filter(function (p) { return p.id === item.pitch_id; })[0];
    if (!pitch || seen[item.pitch_id]) throw new Error('広報批評に未知または重複した企画IDがあります');
    seen[item.pitch_id] = true;
    return pitch;
  }
  var selected = raw.selected.map(function (s) {
    var pitch = findPitch(s);
    ['novelty', 'specificity', 'recruiting', 'depth', 'speakability', 'clarity'].forEach(function (key) {
      if (!Number.isInteger(s[key]) || s[key] < 4 || s[key] > 5) throw new Error('広報批評の品質基準に達していません');
    });
    return { pitch: pitch, novelty: s.novelty, specificity: s.specificity, recruiting: s.recruiting,
      depth: s.depth, speakability: s.speakability, clarity: s.clarity,
      reason: editorialText(s, 'reason', 240), revision: editorialText(s, 'revision', 240) };
  });
  var rejected = raw.rejected.map(function (r) {
    findPitch(r);
    return { pitch_id: r.pitch_id, reason: editorialText(r, 'reason', 160) };
  });
  if (Object.keys(seen).length !== discussion.pitches.length) throw new Error('広報批評に未評価の企画があります');
  if (themes.some(function (t) { return !selected.some(function (s) { return s.pitch.theme === t.theme; }); })) throw new Error('広報批評に含まれないテーマがあります');
  return { critique: editorialText(raw, 'critique', 240), selected: selected, rejected: rejected };
}

function runEditorialRoom(input, deadline) {
  var pitchCount = input.count + 2;
  // 各段階1回。形式失敗時に会議を省略したり、直接台本生成へ戻ったりしない。
  function call(system, payload, tokens) {
    checkEditorialTime(deadline, 30000);
    var text = askAI(system, JSON.stringify(payload), tokens);
    checkEditorialTime(deadline, 0);
    try { return parseJsonLoose(text); }
    catch (e) { throw new Error('編集会議のJSON形式が不正です'); }
  }
  var discussion = validateEditorialDiscussion(call(editorialDiscussionSystem(),
    Object.assign({}, input, { pitch_count: pitchCount }), 2500 + pitchCount * 550), input.themes, pitchCount);
  var review = validateEditorialReview(call(editorialReviewSystem(),
    { recruiting: input.recruiting, count: input.count, themes: input.themes, recent_questions: input.recent_questions, discussion: discussion },
    1500 + input.count * 450), discussion, input.themes, input.count);
  return { discussion: discussion, review: review };
}

function checkEditorialTime(deadline, reserveMs) {
  if (deadline - Date.now() < reserveMs) throw new Error('台本生成の時間予算に達しました。再実行するか質問数を減らしてください');
}
