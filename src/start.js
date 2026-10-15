// The page's entry: the loading screen asks for a world first, and only then does the game (main.js,
// with three.js, Rapier, the textures and the sounds) load. A world already chosen (?terrain, or a
// pick in the panel that reloaded into it) or a browser driven by a script skips the question.
import { createLoadingScreen } from './ui/loading.js';
import { WORLDS, chosenWorld, pickWorld, worldMode } from './world.js';

const loading = createLoadingScreen();

async function start() {
  const chosen = chosenWorld();
  const mode = await loading?.levels(WORLDS, chosen ?? worldMode(), { ask: !chosen && !navigator.webdriver });
  // Modules read the world as they load (render/river-ground.js).
  if (mode && mode !== worldMode()) pickWorld(mode);
  const { main } = await import('./main.js');
  await main(loading);
}

start().catch((error) => {
  console.error(error);
  loading?.remove();
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
