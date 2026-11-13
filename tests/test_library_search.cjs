const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the real library renderer, including its private filter function.
function library(items, account = true) {
  const elements = {};
  const element = key => (elements[key] ||= {
    classList: { toggle() {} }, addEventListener() {}, innerHTML: '', value: ''
  });
  const PR = {
    account, ls: { get: (key, fallback) => fallback, set() {} },
    applyTheme() {}, icon: () => '', esc: String, $: element, $$: () => [],
    renderSide() {}, debounce: fn => fn
  };
  const ctx = {
    PR, document: { addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame: fn => fn()
  };
  ctx.window = { PR, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync('easyread/web/js/library/app.js', 'utf8'), ctx);
  PR.lib.items = items;
  PR.lib.VIEWS = [['all', '全部', '', () => true]];
  return (q, tag = null) => {
    PR.lib.q = q; PR.lib.tag = tag; PR.lib.render();
    return [...elements['#list'].innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]).sort();
  };
}

const paper = (id, fields) => ({id, title_en: '', title_zh: '', authors: '', tags: [], ...fields});
const items = [
  paper('a', {title_en: 'LoRA Adaptation', title_zh: '大模型低秩适配', authors: 'Edward Hu', tags: ['方法']}),
  paper('b', {title_en: 'Attention Is All You Need', title_zh: '注意力机制', authors: 'Ashish Vaswani', tags: ['方法']}),
  paper('c', {title_en: 'Survey', title_zh: '低秩适配综述', authors: 'Other Author', tags: ['综述']}),
  paper('d', {title_en: 'No Chinese Title', title_zh: null, authors: 'Nobody', venue: 'SecretVenue', abstract: 'SecretAbstract', tags: ['SecretTag']})
];

test('CR-001 Chinese title keyword returns all matching personal papers', () => {
  assert.deepEqual(library(items)('低秩适配'), ['a', 'c']);
});
test('CR-001 English title matching remains case insensitive', () => {
  assert.deepEqual(library(items)('lOrA'), ['a']);
});
test('CR-001 author matching remains case insensitive', () => {
  assert.deepEqual(library(items)('eDWaRD'), ['a']);
});
test('CR-001 keyword intersects the selected tag and clearing restores results', () => {
  const search = library(items);
  assert.deepEqual(search('低秩适配', '方法'), ['a']);
  assert.deepEqual(search('低秩适配', '综述'), ['c']);
  assert.deepEqual(search('', '方法'), ['a', 'b']);
  assert.deepEqual(search('低秩适配'), ['a', 'c']);
});
test('CR-001 missing Chinese title and unmatched keywords are safe', () => {
  assert.deepEqual(library(items)('missing-keyword'), []);
  assert.deepEqual(library(items)('No Chinese'), ['d']);
});
test('CR-001 does not expand account search to abstract venue tags or multi-keyword OR', () => {
  const search = library(items);
  for (const q of ['SecretAbstract', 'SecretVenue', 'SecretTag', 'LoRA Attention']) {
    assert.deepEqual(search(q), []);
  }
});
test('CR-001 empty or whitespace keyword keeps the current library', () => {
  assert.deepEqual(library(items)('   '), ['a', 'b', 'c', 'd']);
});
test('CR-001 preserves the original non-account search fields', () => {
  assert.deepEqual(library(items, false)('SecretAbstract'), ['d']);
  assert.deepEqual(library(items, false)('低秩适配'), ['a', 'c']);
});
