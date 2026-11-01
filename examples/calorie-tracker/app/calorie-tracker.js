/**
 * app/calorie-tracker.js — Calorie & Macro Tracker (use-ready example)
 *
 * Quiet utility. Uses only the collections facade — never adapters or sync:
 *   import { db } from '../core/db-api.js';
 */

import { db } from '../core/db-api.js';

const MEALS = 'meals';
const GOALS_KEY = 'prompt2ui:calorie-goals';

const DEFAULT_GOALS = { calories: 2000, protein: 150, carbs: 200, fat: 65 };

function loadGoals() {
  try {
    return { ...DEFAULT_GOALS, ...JSON.parse(localStorage.getItem(GOALS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_GOALS };
  }
}

function saveGoals(goals) {
  localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function macrosOf(items) {
  return items.reduce(
    (acc, i) => ({
      calories: acc.calories + (Number(i.calories) || 0),
      protein: acc.protein + (Number(i.protein) || 0),
      carbs: acc.carbs + (Number(i.carbs) || 0),
      fat: acc.fat + (Number(i.fat) || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

function pct(value, goal) {
  if (!goal) return 0;
  return Math.min(100, Math.round((value / goal) * 100));
}

/**
 * @param {HTMLElement} root
 */
export async function mount(root) {
  const meals = db.collection(MEALS);
  let goals = loadGoals();
  let filterDate = todayISO();
  let unsub = null;

  root.innerHTML = `
    <div class="micro-app calorie-app" data-app="calorie-tracker">
      <header class="micro-header">
        <div>
          <p class="micro-eyebrow">Today’s intake</p>
          <h2 class="micro-title">Meals</h2>
          <p class="micro-sub">Log food. Watch macros against your goals.</p>
        </div>
        <label class="date-filter">
          <span>Day</span>
          <input type="date" id="ct-date" value="${filterDate}" />
        </label>
      </header>

      <section class="macro-bars" id="ct-bars" aria-live="polite"></section>

      <form class="entry-form" id="ct-form" autocomplete="off">
        <div class="form-row">
          <label>
            <span>Food</span>
            <input name="name" required placeholder="Greek yogurt + berries" maxlength="120" />
          </label>
          <label>
            <span>kcal</span>
            <input name="calories" type="number" min="0" step="1" required placeholder="220" />
          </label>
        </div>
        <div class="form-row macros-row">
          <label>
            <span>Protein (g)</span>
            <input name="protein" type="number" min="0" step="0.1" value="0" />
          </label>
          <label>
            <span>Carbs (g)</span>
            <input name="carbs" type="number" min="0" step="0.1" value="0" />
          </label>
          <label>
            <span>Fat (g)</span>
            <input name="fat" type="number" min="0" step="0.1" value="0" />
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Add meal</button>
          <button type="button" class="btn btn-ghost" id="ct-goals-btn">Goals</button>
        </div>
      </form>

      <div class="goals-panel hidden" id="ct-goals">
        <h3>Daily goals</h3>
        <div class="form-row macros-row">
          <label><span>kcal</span><input type="number" id="g-cal" min="1" /></label>
          <label><span>Protein</span><input type="number" id="g-pro" min="0" /></label>
          <label><span>Carbs</span><input type="number" id="g-carb" min="0" /></label>
          <label><span>Fat</span><input type="number" id="g-fat" min="0" /></label>
        </div>
        <button type="button" class="btn btn-primary" id="ct-goals-save">Save goals</button>
      </div>

      <ul class="entry-list" id="ct-list"></ul>
    </div>
  `;

  const barsEl = root.querySelector('#ct-bars');
  const listEl = root.querySelector('#ct-list');
  const form = root.querySelector('#ct-form');
  const dateInput = root.querySelector('#ct-date');
  const goalsPanel = root.querySelector('#ct-goals');

  function renderBars(dayItems) {
    const totals = macrosOf(dayItems);
    const rows = [
      { key: 'calories', label: 'kcal', color: 'var(--accent)' },
      { key: 'protein', label: 'Protein', color: 'var(--accent-2)' },
      { key: 'carbs', label: 'Carbs', color: 'var(--warn)' },
      { key: 'fat', label: 'Fat', color: 'var(--muted-accent)' },
    ];
    barsEl.innerHTML = rows
      .map((r) => {
        const val = Math.round(totals[r.key] * 10) / 10;
        const goal = goals[r.key];
        const p = pct(val, goal);
        return `
          <div class="macro-bar-row">
            <strong>${r.label}</strong>
            <div class="macro-track" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${r.label}">
              <div class="macro-fill" style="--p:${p}; --bar:${r.color}"></div>
            </div>
            <span class="macro-nums">${val} / ${goal}</span>
          </div>`;
      })
      .join('');
  }

  function renderList(dayItems) {
    if (!dayItems.length) {
      listEl.innerHTML = `<li class="empty-state">No meals yet — add the first one above.</li>`;
      return;
    }
    listEl.innerHTML = dayItems
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(
        (item) => `
        <li class="entry-item" data-id="${item.id}">
          <div class="entry-main">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="entry-macros">
              ${item.calories} kcal · P ${item.protein || 0} · C ${item.carbs || 0} · F ${item.fat || 0}
            </span>
          </div>
          <button type="button" class="btn-icon" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </button>
        </li>`
      )
      .join('');
  }

  function paint(allItems) {
    const dayItems = allItems.filter((i) => (i.date || todayISO()) === filterDate);
    renderBars(dayItems);
    renderList(dayItems);
  }

  unsub = meals.subscribe(paint);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await meals.add({
      name: String(fd.get('name')).trim(),
      calories: Number(fd.get('calories')) || 0,
      protein: Number(fd.get('protein')) || 0,
      carbs: Number(fd.get('carbs')) || 0,
      fat: Number(fd.get('fat')) || 0,
      date: filterDate,
    });
    form.reset();
    form.querySelector('[name="protein"]').value = '0';
    form.querySelector('[name="carbs"]').value = '0';
    form.querySelector('[name="fat"]').value = '0';
    form.querySelector('[name="name"]').focus();
  });

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    await meals.remove(btn.getAttribute('data-remove'));
  });

  dateInput.addEventListener('change', async () => {
    filterDate = dateInput.value || todayISO();
    paint(await meals.get());
  });

  root.querySelector('#ct-goals-btn').addEventListener('click', () => {
    goalsPanel.classList.toggle('hidden');
    root.querySelector('#g-cal').value = goals.calories;
    root.querySelector('#g-pro').value = goals.protein;
    root.querySelector('#g-carb').value = goals.carbs;
    root.querySelector('#g-fat').value = goals.fat;
  });

  root.querySelector('#ct-goals-save').addEventListener('click', async () => {
    goals = {
      calories: Number(root.querySelector('#g-cal').value) || DEFAULT_GOALS.calories,
      protein: Number(root.querySelector('#g-pro').value) || 0,
      carbs: Number(root.querySelector('#g-carb').value) || 0,
      fat: Number(root.querySelector('#g-fat').value) || 0,
    };
    saveGoals(goals);
    goalsPanel.classList.add('hidden');
    paint(await meals.get());
  });

  return {
    title: 'Calorie Tracker',
    unmount() {
      if (unsub) unsub();
      root.innerHTML = '';
    },
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
