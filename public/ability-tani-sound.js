const queryInput = document.getElementById('query');
const leftQueryInput = document.getElementById('leftQuery');
const buildButton = document.getElementById('buildButton');
const extractButton = document.getElementById('extractButton');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const zcScopeButton = document.getElementById('zcScopeButton');
const allScopeButton = document.getElementById('allScopeButton');
const reviewFiltersEl = document.getElementById('reviewFilters');
const soundFiltersEl = document.getElementById('soundFilters');
const showDuplicatesInput = document.getElementById('showDuplicates');
const recentChangedEl = document.getElementById('recentChanged');
const resultsEl = document.getElementById('results');
const detailEl = document.getElementById('detail');
const rootsEl = document.getElementById('roots');
const reportButton = document.getElementById('reportButton');
const reportModal = document.getElementById('reportModal');
const reportTitleEl = document.getElementById('reportTitle');
const reportSummaryEl = document.getElementById('reportSummary');
const reportBodyEl = document.getElementById('reportBody');
const reportExportButton = document.getElementById('reportExportButton');
const reportCloseButton = document.getElementById('reportCloseButton');
const reportEditorModal = document.getElementById('reportEditorModal');
const reportEditorTitleEl = document.getElementById('reportEditorTitle');
const reportEditorBodyEl = document.getElementById('reportEditorBody');
const reportEditorCloseButton = document.getElementById('reportEditorCloseButton');

const REVIEW_STATUSES = ['已确认', '未确认', '丢弃', '未找到', '无需声音'];
const REVIEW_FILTER_ORDER = ['未确认', '已确认', '未找到', '无需声音', '丢弃'];
const MAX_RECENT_CHANGED = 1;
const FILTER_STORAGE_KEY = 'ability-tani-sound:filters:v1';
const REVIEW_CLASS = {
  已确认: 'review-confirmed',
  未确认: 'review-unconfirmed',
  丢弃: 'review-discarded',
  未找到: 'review-missing',
  无需声音: 'review-no-sound',
};
const ZC_ABILITY_PAIRS = [
  ['回风扫叶', 'menghu_xiasha'],
  ['蹑云逐月', 'nieyun_zhuyue'],
  ['迎风回浪', 'yingfeng_huilang'],
  ['凌霄揽胜', 'lingxiao_lansheng'],
  ['瑶台枕鹤', 'yaotai_zhenhe'],
  ['扶摇直上', 'fuyao_zhishang'],
  ['后撤', 'houyao'],
  ['疾', 'ji'],
  ['御骑', 'yuqi'],
  ['任驰骋', 'ren_chi_cheng'],
  ['剑破虚空', 'jianpo_xukong'],
  ['三环套月', 'sanhuan_taoyue'],
  ['龙吟', 'long_yin'],
  ['百足', 'baizu'],
  ['五方行尽', 'wufang_xingjin'],
  ['棒打狗头', 'bang_da_gou_tou'],
  ['截阳', 'jieyang'],
  ['风流云散', 'feng_liu_yun_san'],
  ['引窍', 'yin_qiao'],
  ['龙战于野', 'long_zhan_yu_ye'],
  ['潜龙勿用', 'qian_long_wu_yong'],
  ['斗转星移', 'dou_zhuan_xing_yi'],
  ['守缺式', 'shou_que_shi'],
  ['捉影式', 'zhuo_ying_shi'],
  ['摩诃无量', 'mohe_wuliang'],
  ['生死劫', 'shengsi_jie'],
  ['蟾啸', 'chan_xiao'],
  ['大狮子吼', 'da_shizi_hou'],
  ['疾如风', 'jiru_feng'],
  ['散流霞', 'sanliu_xia'],
  ['鹊踏枝', 'que_ta_zhi'],
  ['云栖松', 'yun_qi_song'],
  ['守如山', 'shou_ru_shan'],
  ['风袖低昂', 'fengxiu_diang'],
  ['穹隆化生', 'qionglong_huasheng'],
  ['暗尘弥散', 'anchen_misan'],
  ['浮光掠影', 'fuguang_lueying'],
  ['天地无极', 'tiandi_wuji'],
  ['风来吴山', 'fenglai_wushan'],
  ['无间狱', 'wu_jianyu'],
  ['心诤', 'xinzheng'],
  ['女娲补天', 'nuwa_butian'],
  ['踏星行', 'taxingxing'],
  ['追命箭', 'zhuiming_jian'],
  ['龙牙', 'zhenshen_xingsi'],
  ['鸟翔碧空', 'niao_xiang_bi_kong'],
  ['千蝶吐瑞', 'qiandie_turui'],
  ['笑醉狂', 'xiao_zui_kuang'],
  ['狂龙乱舞', 'kuang_long_luan_wu'],
  ['镇山河', 'zhen_shan_he'],
  ['云飞玉皇', 'yun_fei_yu_huang'],
  ['孔雀翎', 'kong_que_ling'],
  ['韦陀献杵', 'weituo_xianchu'],
  ['雷震子', 'leizhenzi'],
  ['转乾坤', 'zhuan_qiankun'],
  ['夺命蛊', 'duoming_gu'],
  ['紫气东来', 'zi_qi_dong_lai'],
  ['撼如雷', 'han_ru_lei'],
  ['帝骖龙翔', 'dican_longxiang'],
  ['花语酥心', 'huayu_suxin'],
  ['蝶弄足', 'dienong_zu'],
  ['长针', 'changzhen'],
  ['星楼月影', 'xinglou_yueying'],
  ['锻骨诀', 'duangu_jue'],
  ['坐忘无我', 'zuowang_wuwo'],
  ['蛊虫献祭', 'guchong_xianji'],
  ['化血镖', 'hua_xue_biao'],
  ['春泥护花', 'chun_ni_hu_hua'],
  ['圣明佑', 'sheng_ming_you'],
  ['烟雨行', 'yan_yu_xing'],
  ['太阴指', 'tai_yin_zhi'],
  ['万剑归宗', 'wan_jian_gui_zong'],
  ['孤风飒踏', 'gu_feng_sa_ta'],
  ['撼地', 'han_di'],
  ['九转归一', 'jiu_zhuan_gui_yi'],
  ['跃潮斩波', 'yue_chao_zhan_bo'],
  ['无我无剑', 'wu_wo_wu_jian'],
  ['听雷', 'ting_lei'],
  ['绛唇珠袖', 'jiang_chun_zhu_xiu'],
  ['鹤归孤山', 'he_gui_gu_shan'],
  ['天地低昂', 'tian_di_di_ang'],
  ['剑转流云', 'jian_zhuan_liu_yun'],
  ['净世破魔击', 'jing_shi_po_mo_ji'],
  ['兰摧玉折', 'lan_cui_yu_zhe'],
  ['商阳指', 'shang_yang_zhi'],
  ['钟林毓秀', 'zhong_lin_yu_xiu'],
  ['蛇影', 'she_ying'],
  ['玉石俱焚', 'yu_shi_ju_fen'],
  ['芙蓉并蒂', 'fu_rong_bing_di'],
  ['雷霆震怒', 'lei_ting_zhen_nu'],
  ['穿心弩', 'chuan_xin_nu'],
  ['三才化生', 'san_cai_hua_sheng'],
  ['银月斩', 'yin_yue_zhan'],
  ['烈日斩', 'lie_ri_zhan'],
  ['横扫六合', 'heng_sao_liu_he'],
  ['七星拱瑞', 'qixing_gongrui'],
  ['啸如虎', 'xiao_ru_hu'],
  ['穿', 'chuan'],
  ['五蕴皆空', 'wuyun_jiekong'],
  ['玄水蛊', 'xuanshui_gu'],
  ['极乐引', 'ji_le_yin'],
  ['大道无术', 'da_dao_wu_shu'],
  ['沧月', 'cang_yue'],
  ['驱夜断愁', 'qu_ye_duan_chou'],
  ['捕风式', 'bu_feng_shi'],
  ['幽月轮', 'you_yue_lun'],
  ['徐如林', 'xu_ru_lin'],
  ['亢龙有悔', 'kang_long_you_hui'],
  ['抱残式', 'bao_can_shi'],
  ['太极无极', 'tai_ji_wu_ji'],
  ['拿云式', 'na_yun_shi'],
  ['龙啸九天', 'long_xiao_jiu_tian'],
  ['驭羽骋风', 'yu_yu_cheng_feng'],
  ['梯云纵', 'ti_yun_zong'],
  ['凌然天风', 'ling_ran_tian_feng'],
  ['惊鸿游龙', 'jing_hong_you_long'],
  ['傍花随柳', 'bang_hua_sui_liu'],
  ['化蝶', 'hua_die'],
  ['两仪化形', 'liang_yi_hua_xing'],
  ['少明指', 'shao_ming_zhi'],
  ['琴音共鸣', 'qin_yin_gong_ming'],
  ['临时飞爪', 'lin_shi_fei_zhua'],
  ['剑主天地', 'jian_zhu_tian_di'],
  ['破风', 'po_feng'],
  ['冲阴阳', 'chong_yin_yang'],
  ['凌太虚', 'ling_tai_xu'],
  ['生太极', 'sheng_tai_ji'],
  ['吞日月', 'tun_ri_yue'],
  ['人剑合一', 'ren_jian_he_yi'],
  ['舍身诀', 'she_shen_jue'],
  ['渊', 'yuan'],
  ['听风吹雪', 'ting_feng_chui_xue'],
  ['碎星辰', 'sui_xing_chen'],
  ['破苍穹', 'po_cang_qiong'],
  ['无相诀', 'wu_xiang_jue'],
  ['应天授命', 'ying_tian_shou_ming'],
  ['斩无常', 'zhan_wu_chang'],
  ['雾暗迷云', 'wu_an_mi_yun'],
  ['灭', 'mie'],
  ['孤影化双', 'gu_ying_hua_shuang'],
  ['逐云寒蕊', 'zhu_yun_han_rui'],
  ['疾电叱羽', 'ji_dian_chi_yu'],
  ['乘黄之威', 'cheng_huang_zhi_wei'],
  ['振翅图南', 'zhen_chi_tu_nan'],
  ['飞刃回转', 'fei_ren_hui_zhuan'],
  ['天绝地灭', 'tian_jue_di_mie'],
  ['游风飘踪', 'you_feng_piao_zong'],
  ['如意法', 'ru_yi_fa'],
  ['十方玄机', 'shi_fang_xuan_ji'],
  ['蚀心蛊', 'shi_xin_gu'],
  ['鸿蒙天禁', 'hong_meng_tian_jin'],
  ['盾立', 'dun_li'],
  ['迷心蛊', 'mi_xin_gu'],
  ['枯残蛊', 'ku_can_gu'],
  ['楚河汉界', 'chu_he_han_jie'],
  ['绿野蔓生', 'lv_ye_man_sheng'],
  ['连环弩', 'lian_huan_nu'],
  ['翔极碧落', 'xiang_ji_bi_luo'],
  ['剑飞惊天', 'jian_fei_jing_tian'],
  ['怖畏暗刑', 'bu_wei_an_xing'],
  ['霞流宝石', 'xia_liu_bao_shi'],
  ['洗兵雨', 'xi_bing_yu'],
  ['抢珠式', 'qiang_zhu_shi'],
  ['九霄风雷', 'jiu_xiao_feng_lei'],
  ['洞烛机微', 'dong_zhu_ji_wei'],
  ['魂压怒涛', 'hun_ya_nu_tao'],
  ['真·下车', 'zhen_xia_che'],
];
const ZC_ABILITIES = ZC_ABILITY_PAIRS.map(([name, slug], index) => ({ index: index + 1, name, slug, key: normalizeAbilityName(name) }));
const ZC_ABILITY_BY_KEY = new Map(ZC_ABILITIES.map((ability) => [ability.key, ability]));
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_ACTIVE_WEMS = 12;
const PREFETCH_NEIGHBOR_ENTRIES = 10;
const PREFETCH_NEIGHBOR_WEMS = 2;
const DETAIL_RENDER_DEBOUNCE_MS = 120;

let cache = null;
let review = { ok: true, entries: {} };
let activeKey = '';
let searchQuery = '';
let soundFilter = 'all';
let statusFilter = 'all';
let zcAbilitiesOnly = true;
let showDuplicates = false;
let reportFilter = 'good';
let reportEditorKey = '';
let selectionPlayToken = 0;
let reportPlayToken = 0;
let reportExportBusy = false;
let reportExportMessage = '';
let reportBaseSummary = '';
let recentChangedKeys = [];
const cdnCache = new Map();
const cdnLoading = new Set();
const queuedCdnLookups = new Set();
const cdnRenderRequests = new Set();
const cdnPrefetchQueue = [];
let cdnPrefetchActive = 0;
let detailRenderTimer = 0;

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function entryKey(entry) {
  return `${entry?.prefix || ''}:${entry?.id || ''}:${entry?.kind || ''}`;
}

function entryByKey(key) {
  return (cache?.results || []).find((entry) => entryKey(entry) === key)
    || zcUnmatchedEntries(cache?.results || []).find((entry) => entryKey(entry) === key)
    || null;
}

function normalizeAbilityName(value) {
  return String(value || '').replace(/^(绝境|伪传|道具)[·_]/, '').replace(/^(绝境|伪传|道具)/, '').replace(/[·_\s]/g, '').trim();
}

function trimAbilityPrefix(value) {
  return String(value || '').replace(/^(绝境|伪传|道具)[·._\s-]*/u, '').trim();
}

function displayGroupKey(entry) {
  return `${entry?.prefix || ''}:${entry?.name || ''}`;
}

function zcAbilityForEntry(entry) {
  if (!entry) return null;
  if (entry.zcAbility) return entry.zcAbility;
  return ZC_ABILITY_BY_KEY.get(normalizeAbilityName(entry.name)) || null;
}

function zcMatchedGroups(sourceEntries = cache?.results || []) {
  const groups = new Map();
  for (const entry of sourceEntries) {
    const zcAbility = zcAbilityForEntry(entry);
    if (!zcAbility) continue;
    if (!groups.has(zcAbility.key)) groups.set(zcAbility.key, { ability: zcAbility, entries: [] });
    groups.get(zcAbility.key).entries.push(entry);
  }
  return ZC_ABILITIES.map((ability) => groups.get(ability.key)).filter(Boolean);
}

function zcFallbackEntry(ability) {
  const entry = (cache?.zcFallbacks || []).find((item) => item.id === ability.slug || item.zcAbility?.slug === ability.slug);
  if (!entry) return null;
  return { ...entry, zcAbility: ability, prefix: 'ZC', id: ability.slug, kind: 'unmatched' };
}

function buildZcUnmatchedEntry(ability) {
  const fallback = zcFallbackEntry(ability);
  if (fallback) return fallback;
  return {
    zcAbility: ability,
    prefix: 'ZC',
    id: ability.slug,
    kind: 'unmatched',
    name: ability.name,
    term: { label: ability.name },
    found: false,
    counts: { tani: 0, indexedTani: 0, wems: 0 },
    taniResults: [],
    wems: [],
    events: [],
  };
}

function isZcUnmatchedEntry(entry) {
  return entry?.prefix === 'ZC' && entry?.kind === 'unmatched';
}

function zcUnmatchedEntries(sourceEntries = cache?.results || []) {
  const matchedKeys = new Set(zcMatchedGroups(sourceEntries).map(({ ability }) => ability.key));
  return ZC_ABILITIES.filter((ability) => !matchedKeys.has(ability.key)).map((ability) => buildZcUnmatchedEntry(ability));
}

function entriesForDisplayGroupKey(groupKey, sourceEntries = cache?.results || []) {
  return sourceEntries.filter((entry) => displayGroupKey(entry) === groupKey);
}

function groupedDisplayEntries(sourceEntries = cache?.results || []) {
  const groups = [];
  const seen = new Set();
  for (const entry of sourceEntries) {
    const groupKey = displayGroupKey(entry);
    if (!groupKey || seen.has(groupKey)) continue;
    seen.add(groupKey);
    groups.push(entriesForDisplayGroupKey(groupKey));
  }
  return groups.filter((entries) => entries.length);
}

function rememberRecentChanged(entryOrKey) {
  const key = typeof entryOrKey === 'string' ? entryOrKey : entryKey(entryOrKey);
  if (!key) return;
  recentChangedKeys = [key, ...recentChangedKeys.filter((item) => item !== key)].slice(0, MAX_RECENT_CHANGED);
}

function mergeRecentChangedFromReview() {
  const persistedKeys = Object.values(review?.entries || {})
    .sort((left, right) => (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0))
    .map((entry) => entry.abilityKey)
    .filter((key) => !!entryByKey(key));
  recentChangedKeys = [...new Set([...recentChangedKeys, ...persistedKeys])].slice(0, MAX_RECENT_CHANGED);
}

function abilityPayload(entry) {
  return {
    abilityKey: entryKey(entry),
    id: String(entry.id || ''),
    prefix: entry.prefix || '',
    kind: entry.kind || 'skill',
    name: entry.name || '',
  };
}

function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function loadFilterState() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}');
    if (saved.scope === 'all') zcAbilitiesOnly = false;
    if (saved.scope === 'zc') zcAbilitiesOnly = true;
    if (['all', 'one', 'many', 'none'].includes(saved.soundFilter)) soundFilter = saved.soundFilter;
    if (saved.statusFilter === 'all' || REVIEW_STATUSES.includes(saved.statusFilter)) statusFilter = saved.statusFilter;
    showDuplicates = saved.showDuplicates === true;
    showDuplicatesInput.checked = showDuplicates;
  } catch {
  }
}

function saveFilterState() {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      scope: zcAbilitiesOnly ? 'zc' : 'all',
      soundFilter,
      statusFilter,
      showDuplicates,
    }));
  } catch {
  }
}

function syncToggleControls() {
  if (zcAbilitiesOnly && showDuplicates) {
    showDuplicates = false;
    showDuplicatesInput.checked = false;
  }
  const allCount = showDuplicates ? (cache?.results || []).length : groupedDisplayEntries(cache?.results || []).length;
  zcScopeButton.classList.toggle('active', zcAbilitiesOnly);
  allScopeButton.classList.toggle('active', !zcAbilitiesOnly);
  zcScopeButton.innerHTML = `ZC <span class="button-count">${formatCount(zcDisplayEntries(cache?.results || []).length)}</span>`;
  allScopeButton.innerHTML = `全部 <span class="button-count">${formatCount(allCount)}</span>`;
  allScopeButton.title = `全部 ${formatCount(allCount)}`;
  showDuplicatesInput.disabled = zcAbilitiesOnly;
  showDuplicatesInput.closest('.toggle-label')?.classList.toggle('disabled', zcAbilitiesOnly);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function syncSearchInputs(source = null) {
  if (source !== queryInput && queryInput.value !== searchQuery) queryInput.value = searchQuery;
  if (source !== leftQueryInput && leftQueryInput.value !== searchQuery) leftQueryInput.value = searchQuery;
}

function setSearchQuery(value, source = null) {
  searchQuery = String(value || '');
  syncSearchInputs(source);
  renderResults();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
  return data;
}

function reviewFor(entry) {
  const stored = review?.entries?.[entryKey(entry)] || null;
  return {
    status: REVIEW_STATUSES.includes(stored?.status) ? stored.status : '未确认',
    confirmedWems: Array.isArray(stored?.confirmedWems) ? stored.confirmedWems : [],
  };
}

function reviewRecordFor(entry) {
  return review?.entries?.[entryKey(entry)] || null;
}

function reviewUpdatedAt(entry) {
  return Date.parse(reviewRecordFor(entry)?.updatedAt || 0) || 0;
}

function statusClass(status) {
  return REVIEW_CLASS[status] || REVIEW_CLASS['未确认'];
}

function displayStatusForEntry(entry) {
  const status = reviewFor(entry).status;
  return isZcUnmatchedEntry(entry) && status === '未确认' && !entry.counts.tani && !entry.counts.wems ? '未匹配' : status;
}

function displayStatusClassForEntry(entry) {
  const status = reviewFor(entry).status;
  return isZcUnmatchedEntry(entry) && status === '未确认' && !entry.counts.tani && !entry.counts.wems ? REVIEW_CLASS['未找到'] : statusClass(status);
}

function reviewStatusPriority(status) {
  if (status === '已确认') return 4;
  if (status === '无需声音') return 3;
  if (status === '未找到') return 2;
  if (status === '丢弃') return 1;
  return 0;
}

function primaryEntryForGroup(entries) {
  let best = entries?.[0] || null;
  if (!best) return null;
  for (const entry of entries.slice(1)) {
    const bestStatus = reviewFor(best).status;
    const entryStatus = reviewFor(entry).status;
    const bestDecided = bestStatus !== '未确认';
    const entryDecided = entryStatus !== '未确认';
    if (entryDecided !== bestDecided) {
      if (entryDecided) best = entry;
      continue;
    }
    const bestUpdatedAt = reviewUpdatedAt(best);
    const entryUpdatedAt = reviewUpdatedAt(entry);
    if (entryUpdatedAt !== bestUpdatedAt) {
      if (entryUpdatedAt > bestUpdatedAt) best = entry;
      continue;
    }
    if (reviewStatusPriority(entryStatus) > reviewStatusPriority(bestStatus)) best = entry;
  }
  return best;
}

function zcDisplayEntries(sourceEntries = cache?.results || []) {
  const matchedGroups = new Map(zcMatchedGroups(sourceEntries).map((item) => [item.ability.key, item]));
  return ZC_ABILITIES.map((ability) => {
    const match = matchedGroups.get(ability.key);
    return match ? primaryEntryForGroup(match.entries) : buildZcUnmatchedEntry(ability);
  });
}

function displayEntries(sourceEntries = cache?.results || []) {
  if (zcAbilitiesOnly) return zcDisplayEntries(sourceEntries);
  if (showDuplicates) return sourceEntries;
  return groupedDisplayEntries(sourceEntries).map((entries) => primaryEntryForGroup(entries)).filter(Boolean);
}

function scopeEntries({ applyAudio = true } = {}) {
  if (zcAbilitiesOnly) {
    const entries = zcDisplayEntries(cache?.results || []);
    return applyAudio ? entries.filter(matchesSoundFilter) : entries;
  }
  const sourceEntries = applyAudio ? (cache?.results || []).filter(matchesSoundFilter) : (cache?.results || []);
  return displayEntries(sourceEntries);
}

function audioCountForEntry(entry) {
  return Number(entry?.counts?.wems || 0);
}

function matchesSoundFilter(entry) {
  const count = audioCountForEntry(entry);
  if (soundFilter === 'one') return count === 1;
  if (soundFilter === 'many') return count > 1;
  if (soundFilter === 'none') return count === 0;
  return true;
}

function matchesStatusFilter(entry) {
  return statusFilter === 'all' || reviewFor(entry).status === statusFilter;
}

function soundCounts(sourceEntries = scopeEntries({ applyAudio: false })) {
  const counts = { all: sourceEntries.length, one: 0, many: 0, none: 0 };
  for (const entry of sourceEntries) {
    const count = audioCountForEntry(entry);
    if (count === 1) counts.one += 1;
    else if (count > 1) counts.many += 1;
    else counts.none += 1;
  }
  return counts;
}

function reviewCounts(sourceEntries = cache?.results || []) {
  const counts = { all: 0, 已确认: 0, 未确认: 0, 丢弃: 0, 未找到: 0, 无需声音: 0 };
  for (const entry of sourceEntries) {
    counts.all += 1;
    counts[reviewFor(entry).status] += 1;
  }
  return counts;
}

function updateTopStatus() {
  const counts = reviewCounts(scopeEntries());
  setStatus(`未确认 ${formatCount(counts['未确认'])} / 已确认 ${formatCount(counts['已确认'])}`);
}

function searchableText(entry) {
  const state = reviewFor(entry);
  return [
    entry.name,
    entry.id,
    entry.prefix,
    entry.term?.label,
    state.status,
    ...state.confirmedWems.map((wem) => wem.id),
    ...(entry.taniResults || []).map((item) => item.path),
    ...(entry.events || []).flatMap((event) => [event.name, event.rawEvent, event.id]),
    ...(entry.wems || []).flatMap((wem) => [wem.id, wem.name, wem.bank]),
  ].join(' ').toLowerCase();
}

function entriesForReviewCounts() {
  return scopeEntries({ applyAudio: false });
}

function entriesForSoundCounts() {
  return scopeEntries({ applyAudio: false }).filter(matchesStatusFilter);
}

function matchesSearchQuery(entry, needle) {
  return !needle || searchableText(entry).includes(needle);
}

function matchesZcSearch(zcAbility, entries, needle) {
  if (!needle) return true;
  const zcText = `${zcAbility.index} ${zcAbility.name} ${zcAbility.slug}`.toLowerCase();
  return zcText.includes(needle) || entries.some((entry) => matchesSearchQuery(entry, needle));
}

function filteredEntries() {
  const needle = searchQuery.trim().toLowerCase();
  return scopeEntries()
    .filter((entry) => zcAbilitiesOnly
      ? matchesZcSearch(zcAbilityForEntry(entry), isZcUnmatchedEntry(entry) ? [] : [entry], needle)
      : matchesSearchQuery(entry, needle))
    .filter(matchesStatusFilter);
}

function zcPrimaryForActiveEntry(sourceEntries = cache?.results || []) {
  if (!zcAbilitiesOnly) return null;
  const activeEntry = entryByKey(activeKey);
  const zcAbility = zcAbilityForEntry(activeEntry);
  if (!zcAbility) return null;
  const match = zcMatchedGroups(sourceEntries).find((item) => item.ability.key === zcAbility.key);
  return match ? primaryEntryForGroup(match.entries) : buildZcUnmatchedEntry(zcAbility);
}

function groupHasActiveEntry(entries) {
  return entries.some((entry) => entryKey(entry) === activeKey);
}

function representativeEntryForGroup(entries, visibleKeys = null) {
  if (!entries?.length) return null;
  if (visibleKeys?.has(activeKey)) {
    const activeEntry = entries.find((entry) => entryKey(entry) === activeKey);
    if (activeEntry) return activeEntry;
  }
  if (visibleKeys) {
    const visibleEntry = entries.find((entry) => visibleKeys.has(entryKey(entry)));
    if (visibleEntry) return visibleEntry;
  }
  return entries.find((entry) => entryKey(entry) === activeKey)
    || entries.find((entry) => statusFilter === 'all' || reviewFor(entry).status === statusFilter)
    || entries[0];
}

function renderReviewSummary(entries) {
  const items = REVIEW_FILTER_ORDER
    .map((status) => [status, entries.filter((entry) => reviewFor(entry).status === status).length])
    .filter(([, count]) => count > 0);
  return items.map(([status, count]) => `<span class="${statusClass(status)}">${esc(status)}${entries.length > 1 ? ` ${formatCount(count)}` : ''}</span>`).join('<span class="muted"> / </span>');
}

function recordLabel(entry) {
  return `${String(entry?.kind || '').toUpperCase()} ${entry?.id || ''}`.trim();
}

function renderFilters() {
  syncToggleControls();
  const reviewStatuses = zcAbilitiesOnly
    ? REVIEW_FILTER_ORDER.filter((status) => status !== '丢弃')
    : REVIEW_FILTER_ORDER;
  if (statusFilter !== 'all' && !reviewStatuses.includes(statusFilter)) statusFilter = 'all';
  const reviewTotals = reviewCounts(entriesForReviewCounts());
  const soundTotals = soundCounts(entriesForSoundCounts());
  const filterLabel = (label, count) => `${esc(label)} <span class="button-count">${formatCount(count)}</span>`;
  const soundButtons = [
    ['all', '全部'],
    ['one', '1'],
    ['many', 'many'],
    ['none', 'none'],
  ];
  soundFiltersEl.innerHTML = `<span class="toolbar-label">音频</span>${soundButtons.map(([value, label, total]) => `<button class="filter-button ${soundFilter === value ? 'active' : ''}" type="button" data-sound-filter="${esc(value)}">${filterLabel(label, total ?? soundTotals[value] ?? 0)}</button>`).join('')}`;
  reviewFiltersEl.hidden = false;
  reviewFiltersEl.innerHTML = `<span class="toolbar-label">状态</span><button class="filter-button ${statusFilter === 'all' ? 'active' : ''}" type="button" data-review-filter="all">${filterLabel('全部', reviewTotals.all)}</button>${reviewStatuses
    .map((status) => `<button class="filter-button ${statusFilter === status ? 'active' : ''}" type="button" data-review-filter="${esc(status)}">${filterLabel(status, reviewTotals[status] || 0)}</button>`)
    .join('')}`;
  saveFilterState();
}

function renderRecentChanged() {
  const items = recentChangedKeys.map((key) => entryByKey(key)).filter(Boolean);
  if (!items.length) {
    recentChangedEl.innerHTML = '<div class="recent-empty">No recent changes yet.</div>';
    return;
  }
  recentChangedEl.innerHTML = items.map((entry) => {
    const state = reviewFor(entry);
    const checked = state.confirmedWems.length;
    return `<button class="recent-item ${entryKey(entry) === activeKey ? 'active' : ''}" type="button" data-recent-key="${esc(entryKey(entry))}">
      <span class="result-name">${esc(entry.name)}</span>
      <span class="result-meta"><span class="${statusClass(state.status)}">${esc(state.status)}</span>${checked ? ` - check ${formatCount(checked)}` : ''}</span>
    </button>`;
  }).join('');
}

function scheduleRenderDetail() {
  if (detailRenderTimer) return;
  detailRenderTimer = window.setTimeout(() => {
    detailRenderTimer = 0;
    renderDetail();
  }, DETAIL_RENDER_DEBOUNCE_MS);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForCdnDefault(wemId, timeoutMs = 5000) {
  const id = String(wemId || '');
  const startedAt = Date.now();
  while (!cdnCache.has(id) && (cdnLoading.has(id) || queuedCdnLookups.has(id))) {
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(50);
  }
}

function singleWemId(entry) {
  const wems = allWemsForEntry(entry).filter((wem) => /^\d+$/.test(String(wem?.id || '')));
  return wems.length === 1 ? String(wems[0].id) : '';
}

async function autoPlaySingleWem(entry, token) {
  const wemId = singleWemId(entry);
  if (!wemId) return;
  ensureCdnDefault(wemId);
  await waitForCdnDefault(wemId);
  if (detailRenderTimer) await sleep(DETAIL_RENDER_DEBOUNCE_MS + 30);
  if (token !== selectionPlayToken || entryKey(entry) !== activeKey) return;
  await playWem(wemId);
}

function processCdnPrefetchQueue() {
  while (cdnPrefetchActive < PREFETCH_CONCURRENCY && cdnPrefetchQueue.length) {
    const wemId = cdnPrefetchQueue.shift();
    queuedCdnLookups.delete(wemId);
    if (!wemId || cdnCache.has(wemId) || cdnLoading.has(wemId)) continue;
    cdnPrefetchActive += 1;
    cdnLoading.add(wemId);
    fetchJson(cdnLookupUrl(wemId)).then((data) => {
      cdnCache.set(wemId, data);
    }).catch((error) => {
      cdnCache.set(wemId, { ok: false, error: error.message || String(error), files: [] });
    }).finally(() => {
      cdnLoading.delete(wemId);
      cdnPrefetchActive -= 1;
      if (cdnRenderRequests.delete(wemId)) scheduleRenderDetail();
      processCdnPrefetchQueue();
    });
  }
}

function queueCdnLookup(wemId, { rerender = false } = {}) {
  const id = String(wemId || '');
  if (!id) return;
  if (rerender) cdnRenderRequests.add(id);
  if (cdnCache.has(id) || cdnLoading.has(id) || queuedCdnLookups.has(id)) return;
  queuedCdnLookups.add(id);
  cdnPrefetchQueue.push(id);
  processCdnPrefetchQueue();
}

function prefetchEntryWems(entry, limit) {
  for (const wem of (entry?.wems || []).slice(0, limit)) queueCdnLookup(wem.id);
}

function prefetchVisibleEntries(entries) {
  if (!entries?.length) return;
  const activeIndex = Math.max(entries.findIndex((entry) => entryKey(entry) === activeKey), 0);
  const activeEntry = entries[activeIndex] || entries[0];
  if (activeEntry) prefetchEntryWems(activeEntry, PREFETCH_ACTIVE_WEMS);
  let queuedEntries = 0;
  for (let index = 0; index < entries.length && queuedEntries < PREFETCH_NEIGHBOR_ENTRIES; index += 1) {
    if (index === activeIndex) continue;
    prefetchEntryWems(entries[index], PREFETCH_NEIGHBOR_WEMS);
    queuedEntries += 1;
  }
}

function selectEntry(entry, { autoPlay = true } = {}) {
  if (!entry) return;
  activeKey = entryKey(entry);
  selectionPlayToken += 1;
  const playToken = selectionPlayToken;
  renderResults();
  if (autoPlay) autoPlaySingleWem(entry, playToken);
}

function selectGroup(groupKey, { autoPlay = true } = {}) {
  const visibleKeys = new Set(filteredEntries().map((entry) => entryKey(entry)));
  const entry = representativeEntryForGroup(entriesForDisplayGroupKey(groupKey), visibleKeys);
  if (entry) selectEntry(entry, { autoPlay });
}

function collapsedPrimaryForActiveEntry() {
  if (showDuplicates) return null;
  const activeEntry = entryByKey(activeKey);
  if (!activeEntry) return null;
  return primaryEntryForGroup(entriesForDisplayGroupKey(displayGroupKey(activeEntry)));
}

function renderResults({ autoPlayOnActiveChange = false, fallbackIndex = null } = {}) {
  if (!cache?.ok) {
    resultsEl.innerHTML = '<div class="empty">No cache loaded.</div>';
    countEl.textContent = '0';
    renderRecentChanged();
    return;
  }
  const entries = filteredEntries();
  const totalEntries = scopeEntries();
  countEl.textContent = `${formatCount(entries.length)}/${formatCount(totalEntries.length)}`;
  let activeChanged = false;
  if (!entries.some((entry) => entryKey(entry) === activeKey)) {
    const indexedActive = Number.isInteger(fallbackIndex) && entries.length
      ? entries[Math.min(Math.max(fallbackIndex, 0), entries.length - 1)]
      : null;
    const nextActive = indexedActive || zcPrimaryForActiveEntry((cache?.results || []).filter(matchesSoundFilter)) || collapsedPrimaryForActiveEntry();
    activeKey = nextActive && entries.some((entry) => entryKey(entry) === entryKey(nextActive))
      ? entryKey(nextActive)
      : entryKey(entries[0] || {});
    activeChanged = true;
  }
  resultsEl.innerHTML = entries.map((entry) => renderResultRow(entry)).join('') || '<div class="empty">No abilities match.</div>';
  renderRecentChanged();
  renderDetail();
  prefetchVisibleEntries(entries);
  if (activeChanged && autoPlayOnActiveChange) {
    const entry = entryByKey(activeKey);
    if (entry) {
      selectionPlayToken += 1;
      autoPlaySingleWem(entry, selectionPlayToken);
    }
  }
}

function renderResultRow(entry) {
  const state = reviewFor(entry);
  const confirmed = state.confirmedWems.length;
  const isUnmatched = isZcUnmatchedEntry(entry);
  const zcAbility = zcAbilityForEntry(entry);
  const title = zcAbilitiesOnly && zcAbility ? `${zcAbility.index}. ${zcAbility.name}` : entry.name;
  const slugPrefix = zcAbilitiesOnly && zcAbility ? `${esc(zcAbility.slug)} - ` : '';
  return `<div class="result-row ${entryKey(entry) === activeKey ? 'active' : ''}" data-row-key="${esc(entryKey(entry))}">
    <button class="result-main" type="button" data-key="${esc(entryKey(entry))}">
      <span class="result-name">${esc(title)}</span>
      <span class="result-meta">${slugPrefix}<span class="${displayStatusClassForEntry(entry)}">${esc(displayStatusForEntry(entry))}</span> - ${entry.found ? 'Found Yes' : 'Found No'} - TANI ${formatCount(entry.counts.tani)} - WEM ${formatCount(entry.counts.wems)}${!isUnmatched && confirmed ? ` - check ${formatCount(confirmed)}` : ''}</span>
    </button>
    ${isUnmatched ? '<div></div>' : `<button class="discard-button" type="button" data-action="discard-left" data-key="${esc(entryKey(entry))}" title="丢弃">X</button>`}
  </div>`;
}

function renderKv(items) {
  return `<div class="kv">${items.map(([key, value]) => `<div>${esc(key)}</div><div>${value}</div>`).join('')}</div>`;
}

function eventLabel(event) {
  const wems = (event.wems || []).map((id) => `WEM ${id}`).join(', ');
  return `<div><span class="path">${esc(event.name || event.rawEvent || '')}</span>${wems ? `<div class="muted">${esc(wems)}</div>` : ''}</div>`;
}

function renderTaniTable(entry) {
  if (!entry.taniResults?.length) return '<div class="empty">No TANI name matches.</div>';
  return `<table><thead><tr><th style="width:34%">TANI</th><th style="width:16%">State</th><th>Events / WEM</th></tr></thead><tbody>${entry.taniResults.map((item) => `
    <tr>
      <td><div class="path">${esc(item.path)}</div>${item.refAni ? `<div class="muted">${esc(item.refAni)}</div>` : ''}</td>
      <td>${item.extracted ? '<span class="yes">Extracted</span>' : '<span class="no">Missing</span>'}<div class="muted">${item.indexFile ? 'indexed' : 'not indexed'}</div></td>
      <td>${(item.events || []).map(eventLabel).join('') || (item.unresolvedEvents || []).map((event) => `<div class="muted">${esc(event.rawEvent)}</div>`).join('') || '<span class="muted">No sound tag in index</span>'}</td>
    </tr>`).join('')}</tbody></table>`;
}

function cdnLookupUrl(wemId, all = false) {
  return `/api/ability-matcher/tani-sound-cdn?wem=${encodeURIComponent(wemId)}${all ? '&all=1' : ''}`;
}

function ensureCdnDefault(wemId) {
  const id = String(wemId || '');
  queueCdnLookup(id, { rerender: true });
}

function cdnLink(wemId) {
  const params = new URLSearchParams({ folder: 'data/Wwiseaudio/GeneratedSoundBanks', search: String(wemId), types: 'Sound/WEM' });
  return `/cdn-resource-browser.html?${params.toString()}`;
}

function renderCdnCell(wem) {
  ensureCdnDefault(wem.id);
  const lookup = cdnCache.get(String(wem.id));
  if (!lookup) return '<span class="muted">checking...</span>';
  if (lookup.error) return `<span class="no">${esc(lookup.error)}</span>`;
  const file = lookup.defaultFile;
  const allFiles = lookup.files || [];
  const allList = lookup.all && allFiles.length > 1
    ? `<div class="cdn-list">${allFiles.map((item) => `<div class="path">${esc(item.path)}</div>`).join('')}</div>`
    : '';
  if (!file) return `<span class="no">No CDN WEM</span><div><a class="muted" href="${esc(cdnLink(wem.id))}">CDN Browser</a></div>`;
  return `
    <div class="path">${esc(file.path)}</div>
    <div class="muted">${esc(file.packageName || '')} - ${file.packageDownloaded ? 'ready' : 'listed'} - matches ${formatCount(lookup.totalMatches || 0)}</div>
    <div>
      <button class="mini-button" type="button" data-action="play" data-wem="${esc(wem.id)}">Play</button>
      <button class="mini-button secondary" type="button" data-action="all" data-wem="${esc(wem.id)}">Find all</button>
      <a class="mini-button secondary" href="${esc(cdnLink(wem.id))}">CDN</a>
    </div>
    <div id="audio-${esc(wem.id)}" class="audio-slot"></div>
    ${allList}`;
}

function confirmedWemIds(entry) {
  return new Set(reviewFor(entry).confirmedWems.map((wem) => String(wem.id)));
}

function allWemsForEntry(entry) {
  const rows = new Map();
  for (const wem of entry.wems || []) rows.set(String(wem.id), { ...wem, source: 'candidate' });
  for (const wem of reviewFor(entry).confirmedWems) {
    const id = String(wem.id);
    if (!rows.has(id)) rows.set(id, { id, name: `${id}.wem`, bank: wem.source === 'manual' ? 'manual' : 'confirmed', eventNames: [], source: wem.source || 'manual' });
  }
  return [...rows.values()];
}

function preferredEntryName(entry) {
  const zcAbility = zcAbilityForEntry(entry);
  return zcAbility ? `${zcAbility.index}. ${zcAbility.name}` : trimAbilityPrefix(entry.name || '');
}

function confirmedWemRows(entry) {
  const allRows = new Map(allWemsForEntry(entry).map((wem) => [String(wem.id), wem]));
  return reviewFor(entry).confirmedWems.map((wem) => {
    const id = String(wem.id);
    const base = allRows.get(id) || {
      id,
      name: `${id}.wem`,
      bank: wem.source === 'manual' ? 'manual' : 'confirmed',
      eventNames: [],
      source: wem.source || 'manual',
    };
    return {
      ...base,
      source: wem.source || base.source || 'manual',
    };
  });
}

function renderConfirmedWemEditor(entry) {
  const rows = confirmedWemRows(entry);
  if (!rows.length) return '<div class="manual-editor-empty muted">No confirmed sounds yet.</div>';
  return `<div class="confirmed-sound-list">${rows.map((wem) => `
    <div class="confirmed-sound-row">
      <div class="confirmed-sound-info">
        <div class="path">${esc(wem.id)}</div>
        <div class="muted">${esc(wem.name || `${wem.id}.wem`)} - ${esc(wem.source || wem.bank || 'manual')}</div>
      </div>
      <div class="confirmed-sound-actions">
        <button class="mini-button secondary" type="button" data-action="play-confirmed" data-wem="${esc(wem.id)}" data-slot="confirmed-audio-${esc(wem.id)}">Play</button>
        <button class="mini-button danger" type="button" data-action="delete-confirmed" data-key="${esc(entryKey(entry))}" data-wem="${esc(wem.id)}">Delete</button>
      </div>
    </div>
    <div id="confirmed-audio-${esc(wem.id)}" class="audio-slot"></div>`).join('')}</div>`;
}

function renderManualWem(entry) {
  if (isZcUnmatchedEntry(entry)) return '';
  return `<div class="manual-editor" data-wem-editor-panel>
    <div class="manual-editor-title">Edit WEM IDs for ${esc(preferredEntryName(entry))}</div>
    <div class="manual-editor-hint">Add a new WEM ID, or play and delete already confirmed sounds for this ability.</div>
    ${renderConfirmedWemEditor(entry)}
    <div class="manual-wem">
      <input id="manual-wem-input" class="manual-input" inputmode="numeric" autocomplete="off" placeholder="WEM ID" />
      <button class="mini-button" type="button" data-action="manual-add" data-key="${esc(entryKey(entry))}">Add WEM</button>
    </div>
  </div>`;
}

function renderWemTable(entry) {
  const rows = allWemsForEntry(entry);
  if (!rows.length) return '<div class="empty">No WEM IDs yet.</div>';
  const checked = confirmedWemIds(entry);
  return `<table><thead><tr><th style="width:70px">Check</th><th style="width:120px">WEM ID</th><th style="width:22%">Sound File</th><th style="width:25%">Event</th><th>CDN</th></tr></thead><tbody>${rows.map((wem) => `
    <tr>
      <td class="check-cell"><input class="confirm-check" type="checkbox" data-action="confirm-wem" data-key="${esc(entryKey(entry))}" data-wem="${esc(wem.id)}" ${checked.has(String(wem.id)) ? 'checked' : ''} aria-label="check WEM ${esc(wem.id)}" /></td>
      <td class="path">${esc(wem.id)}</td>
      <td>${esc(wem.name || `${wem.id}.wem`)}<div class="muted">${esc(wem.bank || wem.source || '')}</div></td>
      <td>${(wem.eventNames || []).map((name) => `<div class="path">${esc(name)}</div>`).join('') || '<span class="muted">manual</span>'}</td>
      <td>${renderCdnCell(wem)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function currentEntry() {
  return entryByKey(activeKey);
}

function currentGroupEntries() {
  const entry = currentEntry();
  return entry ? entriesForDisplayGroupKey(displayGroupKey(entry)) : [];
}

function renderGroupOverviewPanel(entries) {
  const entry = representativeEntryForGroup(entries);
  if (!entry || entries.length < 2) return '';
  return `<section class="panel">
      <div class="panel-title">${esc(entry.name)}</div>
      ${renderKv([
        ['Combined', `${formatCount(entries.length)} records`],
        ['Records', entries.map((item) => `<div class="path">${esc(recordLabel(item))}</div>`).join('')],
        ['Review', renderReviewSummary(entries)],
        ['Found', `<span class="${entry.found ? 'yes' : 'no'}">${entry.found ? 'Yes' : 'No'}</span>`],
        ['Search Term', esc(entry.term?.label || '')],
        ['TANI', `${formatCount(entry.counts.tani)} first matches - ${formatCount(entry.counts.indexedTani)} indexed`],
        ['WEM', `${formatCount(entry.counts.wems)} candidates`],
      ])}
      <div class="review-actions variant-list">
        ${entries.map((item) => {
          const state = reviewFor(item);
          return `<button class="mini-button secondary variant-button ${entryKey(item) === activeKey ? 'active' : ''}" type="button" data-action="variant" data-key="${esc(entryKey(item))}">
            <span>${esc(recordLabel(item))}</span>
            <span class="${statusClass(state.status)}">${esc(state.status)}</span>
          </button>`;
        }).join('')}
      </div>
    </section>`;
}

function renderEntryOverviewPanel(entry, title = entry.name) {
  const state = reviewFor(entry);
  const foundClass = entry.found ? 'yes' : 'no';
  const isUnmatched = isZcUnmatchedEntry(entry);
  const zcAbility = zcAbilityForEntry(entry);
  const panelTitle = zcAbilitiesOnly && zcAbility ? `${zcAbility.index}. ${zcAbility.name}` : title;
  const statusActions = isUnmatched ? ['未确认', '未找到', '无需声音'] : ['未确认', '未找到', '无需声音', '丢弃'];
  const items = [];
  if (zcAbility) items.push(['ZC', `${zcAbility.index}. ${zcAbility.name} (${zcAbility.slug})`]);
  if (isUnmatched) items.push(['Cache', '<span class="review-missing">未匹配到缓存能力</span>']);
  items.push(
    ['Review', `<span class="${displayStatusClassForEntry(entry)}">${esc(displayStatusForEntry(entry))}</span>`],
    ['Found', `<span class="${foundClass}">${entry.found ? 'Yes' : 'No'}</span>`],
    ['Search Term', esc(entry.term?.label || '')],
    ['TANI', `${formatCount(entry.counts.tani)} first matches - ${formatCount(entry.counts.indexedTani)} indexed`],
    ['WEM', `${formatCount(entry.counts.wems)} candidates - ${formatCount(state.confirmedWems.length)} checked`],
  );
  return `<section class="panel">
      <div class="panel-title">${esc(panelTitle)}</div>
      ${renderKv(items)}
      <div class="review-actions">
        ${statusActions.map((status) => `<button class="mini-button ${status === '丢弃' ? 'danger' : 'secondary'}" type="button" data-action="status" data-key="${esc(entryKey(entry))}" data-status="${esc(status)}">${esc(status)}</button>`).join('')}
      </div>
    </section>`;
}

function renderDetail() {
  const entry = currentEntry();
  const groupEntries = currentGroupEntries();
  const zcAbility = zcAbilityForEntry(entry);
  if (!entry) {
    detailEl.innerHTML = '<div class="empty">No ability selected.</div>';
    rootsEl.textContent = '';
    return;
  }
  rootsEl.textContent = isZcUnmatchedEntry(entry) && zcAbility
    ? `ZC ${zcAbility.slug}`
    : showDuplicates && groupEntries.length > 1
    ? `${entry.prefix || ''} ${entry.name || ''}`.trim()
    : `${entry.prefix || ''} ${entry.id || ''}`.trim();
  detailEl.innerHTML = `${showDuplicates ? renderGroupOverviewPanel(groupEntries) : ''}${renderEntryOverviewPanel(entry, showDuplicates && groupEntries.length > 1 ? `Record ${recordLabel(entry)}` : entry.name)}
    <section class="panel"><div class="panel-title">WEM Editor</div>${renderManualWem(entry)}${renderWemTable(entry)}</section>
    <section class="panel"><div class="panel-title">TANI</div>${renderTaniTable(entry)}</section>`;
}

function reportSourceEntries() {
  return zcAbilitiesOnly ? zcDisplayEntries(cache?.results || []) : displayEntries(cache?.results || []);
}

function reportWemIds(entry) {
  return [...new Set(reviewFor(entry).confirmedWems.map((wem) => String(wem.id)).filter(Boolean))];
}

function reportNameForEntry(entry) {
  return preferredEntryName(entry);
}

function reportRows() {
  return reportSourceEntries().map((entry) => {
    const state = reviewFor(entry);
    const wems = reportWemIds(entry);
    const status = displayStatusForEntry(entry);
    const noSound = state.status === '无需声音';
    return {
      entry,
      key: entryKey(entry),
      name: reportNameForEntry(entry),
      status,
      wems,
      noSound,
      found: noSound || wems.length > 0,
    };
  });
}

function reportRowByKey(key) {
  return reportRows().find((row) => row.key === key) || null;
}

function stopReportAudio() {
  reportPlayToken += 1;
  reportBodyEl.querySelectorAll('audio').forEach((audio) => audio.pause());
}

function entryMatchesCurrentSearch(entry) {
  const needle = searchQuery.trim().toLowerCase();
  if (!needle) return true;
  return zcAbilitiesOnly
    ? matchesZcSearch(zcAbilityForEntry(entry), isZcUnmatchedEntry(entry) ? [] : [entry], needle)
    : matchesSearchQuery(entry, needle);
}

function editorSearchTextForEntry(entry) {
  const zcAbility = zcAbilityForEntry(entry);
  return zcAbility?.name || trimAbilityPrefix(entry?.name || '') || String(entry?.id || '');
}

function revealEntryForEditor(entry) {
  if (!entry) return;
  const key = entryKey(entry);
  if (filteredEntries().some((item) => entryKey(item) === key)) return;
  soundFilter = 'all';
  statusFilter = 'all';
  if (!entryMatchesCurrentSearch(entry)) {
    searchQuery = editorSearchTextForEntry(entry);
    syncSearchInputs();
  }
  renderFilters();
  updateTopStatus();
}

function focusAbilityEditor(entry = currentEntry(), { focusInput = true } = {}) {
  window.requestAnimationFrame(() => {
    const key = entryKey(entry || {});
    if (key) {
      const row = [...resultsEl.querySelectorAll('.result-row')].find((item) => item.dataset.rowKey === key);
      row?.scrollIntoView({ block: 'center' });
    }
    const panel = detailEl.querySelector('[data-wem-editor-panel]');
    panel?.scrollIntoView({ block: 'start' });
    if (!focusInput) return;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        const input = detailEl.querySelector('#manual-wem-input');
        if (!input) return;
        input.focus({ preventScroll: true });
        input.select?.();
      }, 0);
    });
  });
}

function reportEditorTarget() {
  const row = reportRowByKey(reportEditorKey);
  const entry = row?.entry || entryByKey(reportEditorKey);
  return { row, entry };
}

function renderReportEditorList(entry) {
  const rows = confirmedWemRows(entry);
  if (!rows.length) return '<div class="report-editor-empty muted">No WEM IDs yet.</div>';
  return `<div class="report-editor-wem-list">${rows.map((wem) => `
    <div class="report-editor-wem-row">
      <div class="report-editor-wem-id path">${esc(wem.id)}</div>
      <div class="report-editor-actions">
        <button class="mini-button secondary" type="button" data-report-editor-play="${esc(wem.id)}">Play</button>
        <button class="mini-button danger" type="button" data-report-editor-delete="${esc(wem.id)}">Delete</button>
      </div>
    </div>`).join('')}</div>`;
}

function renderReportEditor({ focusInput = false } = {}) {
  if (!reportEditorModal || !reportEditorTitleEl || !reportEditorBodyEl) return;
  const { row, entry } = reportEditorTarget();
  if (!entry) {
    closeReportEditor();
    return;
  }
  const title = row?.name || preferredEntryName(entry);
  reportEditorTitleEl.textContent = `WEM Editor - ${title}`;
  reportEditorBodyEl.innerHTML = `
    <form class="report-editor-add" data-report-editor-add>
      <input id="report-editor-wem-input" class="manual-input" inputmode="numeric" autocomplete="off" placeholder="WEM ID" />
      <button class="mini-button" type="submit">Add WEM</button>
    </form>
    <div id="reportEditorAudioSlot" class="report-editor-audio-slot audio-slot"></div>
    ${renderReportEditorList(entry)}`;
  if (focusInput) {
    window.requestAnimationFrame(() => reportEditorBodyEl.querySelector('#report-editor-wem-input')?.focus({ preventScroll: true }));
  }
}

function openReportEdit(key) {
  const row = reportRowByKey(key);
  const entry = row?.entry || entryByKey(key);
  if (!entry) return;
  reportEditorKey = entryKey(entry);
  renderReportEditor({ focusInput: true });
  reportEditorModal.hidden = false;
}

function closeReportEditor() {
  if (!reportEditorModal) return;
  reportEditorBodyEl?.querySelectorAll('audio').forEach((audio) => audio.pause());
  reportEditorModal.hidden = true;
  reportEditorKey = '';
}

function reportWemMarkup(row) {
  if (row.wems.length) return row.wems.map((wemId) => `<span>${esc(wemId)}</span>`).join('');
  return row.noSound ? '<span class="review-no-sound">无需声音</span>' : '<span class="no">未分配</span>';
}

function reportPackageRows() {
  return reportRows()
    .filter((row) => row.found && !row.noSound && row.wems.length)
    .map((row) => ({ key: row.key, name: row.name, status: row.status, wems: row.wems }));
}

function syncReportExportUi() {
  const rows = reportPackageRows();
  if (reportExportButton) {
    reportExportButton.disabled = reportExportBusy || !rows.length;
    reportExportButton.textContent = reportExportBusy ? 'Exporting...' : `Export package (${formatCount(rows.length)})`;
  }
  reportSummaryEl.textContent = reportExportMessage ? `${reportBaseSummary} / ${reportExportMessage}` : reportBaseSummary;
}

function renderReportCard(row) {
  const className = row.noSound ? 'found no-sound' : row.found ? 'found' : 'missing';
  const soundCount = row.wems.length;
  const countClass = soundCount === 1 ? 'report-count' : 'report-count bad';
  return `<article class="report-card ${className}">
    <button class="report-card-settings" type="button" data-report-edit="${esc(row.key)}" aria-label="Open ${esc(row.name)} editor" title="Open ${esc(row.name)} editor">&#9881;</button>
    <button class="report-card-play" type="button" data-report-play="${esc(row.key)}">
      <span class="report-card-top">
        <span class="report-name-row">
          <span class="report-name">${esc(row.name)}</span>
          <span class="${countClass}">${formatCount(soundCount)}</span>
        </span>
      </span>
      <span class="report-wems path">${reportWemMarkup(row)}</span>
    </button>
  </article>`;
}

function renderReport() {
  stopReportAudio();
  if (!cache?.ok) {
    reportBodyEl.innerHTML = '<div class="empty">No cache loaded.</div>';
    return;
  }
  const rows = reportRows();
  const goodRows = rows.filter((row) => row.found && !row.noSound);
  const notFoundRows = rows.filter((row) => !row.found);
  const noSoundRows = rows.filter((row) => row.noSound);
  const visibleRows = reportFilter === 'not-found'
    ? notFoundRows
    : reportFilter === 'no-sound'
    ? noSoundRows
    : goodRows;
  const goodPercent = rows.length ? Math.round((goodRows.length / rows.length) * 100) : 0;
  const noSoundPercent = rows.length ? Math.round((noSoundRows.length / rows.length) * 100) : 0;
  const notFoundPercent = rows.length ? Math.max(0, 100 - goodPercent - noSoundPercent) : 0;
  const button = (value, label, count) => `<button class="filter-button ${reportFilter === value ? 'active' : ''}" type="button" data-report-filter="${esc(value)}">${esc(label)} <span class="button-count">${formatCount(count)}</span></button>`;
  reportTitleEl.textContent = `${zcAbilitiesOnly ? 'ZC' : '全部'} Final Report`;
  reportBaseSummary = `${formatCount(goodRows.length)} good / ${formatCount(notFoundRows.length)} not found / ${formatCount(noSoundRows.length)} no sound / ${formatCount(rows.length)} total`;
  syncReportExportUi();
  reportBodyEl.innerHTML = `
    <div class="report-chart">
      <div class="report-chart-numbers">
        <span><strong>${formatCount(goodRows.length)}</strong> Good</span>
        <span><strong>${formatCount(notFoundRows.length)}</strong> Not found</span>
        <span><strong>${formatCount(noSoundRows.length)}</strong> No sound</span>
      </div>
      <div class="report-bar" aria-label="Good ${goodPercent} percent, no sound ${noSoundPercent} percent, not found ${notFoundPercent} percent">
        <span class="report-bar-found" style="width:${goodPercent}%"></span>
        <span class="report-bar-no-sound" style="width:${noSoundPercent}%"></span>
        <span class="report-bar-missing" style="width:${notFoundPercent}%"></span>
      </div>
    </div>
    <div class="report-filter-row">
      ${button('good', 'Good', goodRows.length)}
      ${button('not-found', 'Not found', notFoundRows.length)}
      ${button('no-sound', 'No sound', noSoundRows.length)}
    </div>
    <div id="reportAudioSlot" class="report-audio-slot"></div>
    <div class="report-card-grid">
      ${visibleRows.map(renderReportCard).join('') || '<div class="empty">No report rows.</div>'}
    </div>`;
}

async function exportReportPackage() {
  const rows = reportPackageRows();
  if (!rows.length || reportExportBusy) return;
  reportExportBusy = true;
  reportExportMessage = `exporting ${formatCount(rows.length)} abilities`;
  syncReportExportUi();
  try {
    const result = await fetchJson('/api/ability-matcher/tani-sound-export-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ scope: zcAbilitiesOnly ? 'zc' : 'all', rows }),
    });
    reportExportMessage = `exported ${formatCount(result.counts?.abilities || 0)} abilities, ${formatCount(result.counts?.oggs || 0)} sounds to ${result.outputPath || ''}`;
  } catch (error) {
    reportExportMessage = `export failed: ${error.message || error}`;
  } finally {
    reportExportBusy = false;
    syncReportExportUi();
  }
}

async function playReportRow(key) {
  const row = reportRowByKey(key);
  const slot = document.getElementById('reportAudioSlot');
  if (!row || !slot) return;
  const token = ++reportPlayToken;
  reportBodyEl.querySelectorAll('audio').forEach((audio) => audio.pause());
  if (!row.wems.length) {
    slot.innerHTML = row.noSound ? '<span class="review-no-sound">无需声音</span>' : '<span class="no">未分配</span>';
    return;
  }
  for (let index = 0; index < row.wems.length; index += 1) {
    if (token !== reportPlayToken || reportModal.hidden) return;
    const wemId = row.wems[index];
    const label = row.wems.length > 1 ? `${row.name} ${index + 1}/${row.wems.length} - WEM ${wemId}` : `${row.name} - WEM ${wemId}`;
    await playWem(wemId, slot, { label, waitForEnd: index < row.wems.length - 1 });
  }
}

function openReport() {
  reportFilter = 'good';
  renderReport();
  reportModal.hidden = false;
  document.body.classList.add('modal-open');
  reportCloseButton.focus();
}

function closeReport() {
  closeReportEditor();
  stopReportAudio();
  reportModal.hidden = true;
  document.body.classList.remove('modal-open');
}

async function saveReview(entry, patch, { autoPlayOnActiveChange = true } = {}) {
  const previousIndex = filteredEntries().findIndex((item) => entryKey(item) === entryKey(entry));
  review = await fetchJson('/api/ability-matcher/tani-sound-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ability: abilityPayload(entry),
      status: patch.status,
      confirmedWems: patch.confirmedWems,
    }),
  });
  rememberRecentChanged(entry);
  renderFilters();
  renderResults({ autoPlayOnActiveChange, fallbackIndex: previousIndex });
  updateTopStatus();
}

async function setEntryStatus(entry, status) {
  await saveReview(entry, { status, confirmedWems: reviewFor(entry).confirmedWems });
}

async function toggleConfirmedWem(entry, wemId, checked) {
  const current = reviewFor(entry);
  const existing = current.confirmedWems.filter((wem) => String(wem.id) !== String(wemId));
  const sourceRow = allWemsForEntry(entry).find((wem) => String(wem.id) === String(wemId));
  const next = checked
    ? [...existing, { id: String(wemId), source: sourceRow?.source === 'manual' ? 'manual' : 'candidate' }]
    : existing;
  const nextStatus = next.length ? '已确认' : (current.status === '已确认' ? '未确认' : current.status);
  await saveReview(entry, { status: nextStatus, confirmedWems: next });
}

async function addManualWems(entry) {
  if (isZcUnmatchedEntry(entry)) return;
  const input = detailEl.querySelector('#manual-wem-input');
  const ids = [...new Set((input?.value.match(/\d+/g) || []).map(String))];
  if (!ids.length) return;
  const current = reviewFor(entry);
  const byId = new Map(current.confirmedWems.map((wem) => [String(wem.id), wem]));
  for (const id of ids) byId.set(id, { id, source: 'manual' });
  if (input) input.value = '';
  await saveReview(entry, { status: '已确认', confirmedWems: [...byId.values()] });
  focusAbilityEditor(entry);
}

async function deleteConfirmedWem(entry, wemId) {
  await toggleConfirmedWem(entry, wemId, false);
  focusAbilityEditor(entry);
}

async function addReportEditorWems() {
  const { entry } = reportEditorTarget();
  if (!entry) return;
  const input = reportEditorBodyEl.querySelector('#report-editor-wem-input');
  const ids = [...new Set((input?.value.match(/\d+/g) || []).map(String))];
  if (!ids.length) return;
  const current = reviewFor(entry);
  const byId = new Map(current.confirmedWems.map((wem) => [String(wem.id), wem]));
  for (const id of ids) byId.set(id, { id, source: 'manual' });
  if (input) input.value = '';
  await saveReview(entry, { status: '已确认', confirmedWems: [...byId.values()] }, { autoPlayOnActiveChange: false });
  renderReport();
  renderReportEditor({ focusInput: true });
}

async function deleteReportEditorWem(wemId) {
  const { entry } = reportEditorTarget();
  if (!entry) return;
  const current = reviewFor(entry);
  const next = current.confirmedWems.filter((wem) => String(wem.id) !== String(wemId));
  const nextStatus = next.length ? '已确认' : (current.status === '已确认' ? '未确认' : current.status);
  await saveReview(entry, { status: nextStatus, confirmedWems: next }, { autoPlayOnActiveChange: false });
  renderReport();
  renderReportEditor();
}

async function playReportEditorWem(wemId) {
  const slot = reportEditorBodyEl.querySelector('#reportEditorAudioSlot');
  if (!slot) return;
  stopReportAudio();
  await playWem(wemId, slot, { label: `WEM ${wemId}` });
}

async function loadCache(options = {}) {
  setStatus(options.extract ? 'Extracting...' : 'Loading...');
  buildButton.disabled = true;
  extractButton.disabled = true;
  reportButton.disabled = true;
  try {
    const params = new URLSearchParams({ build: '1' });
    if (options.force) params.set('force', '1');
    if (options.extract) params.set('extract', '1');
    const [cacheData, reviewData] = await Promise.all([
      fetchJson(`/api/ability-matcher/tani-sound-cache?${params.toString()}`),
      fetchJson('/api/ability-matcher/tani-sound-review'),
    ]);
    cache = cacheData;
    review = reviewData;
    mergeRecentChangedFromReview();
    syncSearchInputs();
    syncToggleControls();
    activeKey = activeKey || entryKey(filteredEntries()[0] || cache.results?.[0] || {});
    renderFilters();
    renderResults();
    updateTopStatus();
  } catch (error) {
    detailEl.innerHTML = `<div class="empty">${esc(error.message || error)}</div>`;
    setStatus('Error');
  } finally {
    buildButton.disabled = false;
    extractButton.disabled = false;
    reportButton.disabled = !cache?.ok;
  }
}

async function findAllWem(wemId) {
  const id = String(wemId || '');
  cdnLoading.add(id);
  try {
    cdnCache.set(id, await fetchJson(cdnLookupUrl(id, true)));
  } catch (error) {
    cdnCache.set(id, { ok: false, error: error.message || String(error), files: [] });
  } finally {
    cdnLoading.delete(id);
    renderDetail();
  }
}

async function playWem(wemId, slotOverride = null, options = {}) {
  const id = String(wemId || '');
  const slot = slotOverride || document.getElementById(`audio-${id}`);
  if (!slot) return false;
  slot.textContent = 'loading...';
  try {
    if (!id) throw new Error('No WEM ID');
    if (!cdnCache.has(id) || !cdnCache.get(id)?.defaultFile) cdnCache.set(id, await fetchJson(cdnLookupUrl(id)));
    const file = cdnCache.get(id)?.defaultFile;
    if (!file) throw new Error('No CDN WEM');
    const result = await fetchJson('/api/cdn/hpkg/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ packageName: file.packageName, size: file.packageSize, memberPath: file.path, convertToOgg: true, download: true }),
    });
    if (!result.playback?.url) throw new Error('No playback URL returned');
    slot.innerHTML = `<audio controls autoplay preload="auto" src="${esc(result.playback.url)}"></audio><div class="muted">${esc(options.label || `WEM ${id}`)} - ${esc(result.playback.relativePath || '')}</div>`;
    const audio = slot.querySelector('audio');
    if (options.waitForEnd && audio) {
      await new Promise((resolve) => {
        const done = () => resolve();
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        audio.addEventListener('pause', done, { once: true });
      });
    }
    return true;
  } catch (error) {
    slot.innerHTML = `<span class="no">${esc(error.message || error)}</span>`;
    return false;
  }
}

zcScopeButton.addEventListener('click', () => {
  zcAbilitiesOnly = true;
  if (statusFilter === '丢弃') statusFilter = 'all';
  syncToggleControls();
  renderFilters();
  renderResults({ autoPlayOnActiveChange: true });
  updateTopStatus();
});

allScopeButton.addEventListener('click', () => {
  zcAbilitiesOnly = false;
  syncToggleControls();
  renderFilters();
  renderResults({ autoPlayOnActiveChange: true });
  updateTopStatus();
});

soundFiltersEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-sound-filter]');
  if (!button) return;
  const previousIndex = filteredEntries().findIndex((entry) => entryKey(entry) === activeKey);
  const nextFilter = button.dataset.soundFilter || 'all';
  soundFilter = nextFilter === 'all' || soundFilter === nextFilter ? 'all' : nextFilter;
  renderFilters();
  renderResults({ autoPlayOnActiveChange: true, fallbackIndex: previousIndex });
  updateTopStatus();
});

reviewFiltersEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-filter]');
  if (!button) return;
  const previousIndex = filteredEntries().findIndex((entry) => entryKey(entry) === activeKey);
  const nextFilter = button.dataset.reviewFilter || 'all';
  statusFilter = nextFilter === 'all' || statusFilter === nextFilter ? 'all' : nextFilter;
  renderFilters();
  renderResults({ autoPlayOnActiveChange: true, fallbackIndex: previousIndex });
  updateTopStatus();
});

resultsEl.addEventListener('click', (event) => {
  const discardButton = event.target.closest('[data-action="discard-left"]');
  if (discardButton) {
    const entry = entryByKey(discardButton.dataset.key || '');
    if (entry) setEntryStatus(entry, '丢弃');
    return;
  }
  const button = event.target.closest('[data-key]');
  if (!button) return;
  selectEntry(entryByKey(button.dataset.key || ''));
});

showDuplicatesInput.addEventListener('change', () => {
  showDuplicates = showDuplicatesInput.checked;
  syncToggleControls();
  renderFilters();
  renderResults({ autoPlayOnActiveChange: true });
  updateTopStatus();
});

recentChangedEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-recent-key]');
  if (!button) return;
  selectEntry(entryByKey(button.dataset.recentKey || ''));
});

reportButton.addEventListener('click', () => openReport());

reportExportButton.addEventListener('click', () => exportReportPackage());

reportCloseButton.addEventListener('click', () => closeReport());

reportEditorCloseButton.addEventListener('click', () => closeReportEditor());

reportModal.addEventListener('click', (event) => {
  if (event.target.closest('[data-report-close]')) {
    closeReport();
    return;
  }
  const editButton = event.target.closest('[data-report-edit]');
  if (editButton) {
    openReportEdit(editButton.dataset.reportEdit || '');
    return;
  }
  const card = event.target.closest('[data-report-play]');
  if (card) {
    playReportRow(card.dataset.reportPlay || '');
    return;
  }
  const button = event.target.closest('[data-report-filter]');
  if (!button) return;
  reportFilter = button.dataset.reportFilter || 'all';
  renderReport();
});

reportEditorModal.addEventListener('click', (event) => {
  if (event.target.closest('[data-report-editor-close]')) {
    closeReportEditor();
    return;
  }
  const playButton = event.target.closest('[data-report-editor-play]');
  if (playButton) {
    playReportEditorWem(playButton.dataset.reportEditorPlay || '');
    return;
  }
  const deleteButton = event.target.closest('[data-report-editor-delete]');
  if (deleteButton) deleteReportEditorWem(deleteButton.dataset.reportEditorDelete || '');
});

reportEditorModal.addEventListener('submit', (event) => {
  if (!event.target.closest('[data-report-editor-add]')) return;
  event.preventDefault();
  addReportEditorWems();
});

detailEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const entry = entryByKey(button.dataset.key || activeKey);
  if (action === 'variant') {
    if (entry) selectEntry(entry, { autoPlay: false });
    return;
  }
  if (action === 'all') findAllWem(button.dataset.wem || '');
  if (action === 'play') playWem(button.dataset.wem || '');
  if (action === 'play-confirmed') {
    const slot = button.dataset.slot ? detailEl.querySelector(`#${button.dataset.slot}`) : null;
    playWem(button.dataset.wem || '', slot);
  }
  if (entry && action === 'status') setEntryStatus(entry, button.dataset.status || '未确认');
  if (entry && action === 'manual-add') addManualWems(entry);
  if (entry && action === 'delete-confirmed') deleteConfirmedWem(entry, button.dataset.wem || '');
});

detailEl.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-action="confirm-wem"]');
  const entry = entryByKey(checkbox?.dataset.key || activeKey);
  if (!checkbox || !entry) return;
  toggleConfirmedWem(entry, checkbox.dataset.wem || '', checkbox.checked);
});

detailEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.id !== 'manual-wem-input') return;
  const entry = currentEntry();
  if (entry) addManualWems(entry);
});

queryInput.addEventListener('input', (event) => setSearchQuery(event.target.value, queryInput));
leftQueryInput.addEventListener('input', (event) => setSearchQuery(event.target.value, leftQueryInput));
buildButton.addEventListener('click', () => loadCache({ force: true }));
extractButton.addEventListener('click', () => loadCache({ force: true, extract: true }));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !reportModal.hidden) closeReport();
});

loadFilterState();
syncToggleControls();
loadCache();