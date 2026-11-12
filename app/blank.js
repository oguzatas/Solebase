/**
 * app/blank.js — Personal-app canvas (optional)
 *
 * The repo root serves a static Solebase how-to welcome page.
 * When you build your own app, mount from app.js using Layer 1:
 *
 *   import { Solebase } from '../packages/solebase/dist/index.js';
 *   const db = await Solebase.init({ appId, encryptionKey, workerUrl });
 *   const items = db.collection('items');
 *
 * See docs/solebase-layer1.md and examples/smoke-solebase/.
 */

/**
 * @param {HTMLElement} root
 */
export async function mount(root) {
  root.innerHTML = `
    <div class="blank-canvas" data-app="blank">
      <p class="blank-hint">edit <code>app/</code> — Solebase Layer 1</p>
    </div>
  `;

  return {
    title: 'App',
    unmount() {
      root.innerHTML = '';
    },
  };
}
