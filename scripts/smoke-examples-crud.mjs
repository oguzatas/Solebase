/**
 * CRUD smoke for example collection shapes (Node localStorage backend).
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
globalThis.indexedDB = undefined;

const { PromptDB } = await import('../core/prompt-db.js');

const meals = await PromptDB.open('meals', { useIDB: false });
const m = await meals.add({
  name: 'Oats',
  calories: 300,
  protein: 12,
  carbs: 40,
  fat: 6,
  date: '2026-11-01',
});
assert.equal(meals.get().length, 1);
await meals.update(m.id, { calories: 320 });
assert.equal(meals.find(m.id).calories, 320);
await meals.remove(m.id);
assert.equal(meals.get().length, 0);

const notes = await PromptDB.open('notes', { useIDB: false });
const n = await notes.add({
  title: 'Daily',
  body: '# Hello\n\nWorld',
  folder: 'daily',
  tags: ['daily', 'ideas'],
});
assert.ok(n.id);
await notes.update(n.id, { title: 'Daily note', tags: ['daily'] });
assert.equal(notes.find(n.id).title, 'Daily note');
assert.deepEqual(notes.find(n.id).tags, ['daily']);
await notes.remove(n.id);
assert.equal(notes.get().length, 0);

console.log('SMOKE_EXAMPLES_CRUD_OK');
