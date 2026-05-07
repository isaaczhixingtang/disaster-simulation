const modes = [
  {
    id: "mode-simulator",
    icon: "🧰",
    title: "Simulator",
    description:
      "Top-down god mode. Build villages, summon disasters, watch chaos unfold from above.",
  },
  {
    id: "mode-survival",
    icon: "🏃",
    title: "Survival",
    description:
      "You are inside the world. Disasters strike constantly. Survive as long as you can.",
  },
  {
    id: "mode-construction",
    icon: "🏗️",
    title: "Construction",
    description:
      "Watch buildings rise from the ground: foundations poured, bricks laid, cranes swinging, trucks delivering.",
  },
];

export function ModeOverlays() {
  return (
    <>
      <div id="studio-splash" className="overlay-screen studio-splash" role="button" tabIndex={0}>
        <div className="studio-logo-wrap" aria-hidden="true">
          <img src="/assets/isaac3d-gdev-logo.png" alt="" className="studio-logo" />
        </div>
        <div className="studio-name">Isaac3D GDev</div>
        <div className="studio-loading" aria-live="polite">
          <div className="studio-loading-track" aria-hidden="true">
            <div className="studio-loading-fill" />
          </div>
          <div id="studio-loading-tip" className="studio-loading-tip">
            Tip: Build first. Destroy later.
          </div>
        </div>
      </div>

      <div id="start-screen" className="overlay-screen hidden">
        <h1>🌍 Disaster Sim</h1>
        <p className="tagline">Build a world. Watch it burn. Or live in it.</p>
        <button className="big-btn" id="btn-start">
          ▶ Start
        </button>
      </div>

      <div id="mode-screen" className="overlay-screen hidden">
        <button className="back-btn" id="btn-back-start">
          ← Back
        </button>
        <h1>Choose Mode</h1>
        <p className="tagline">Three ways to play.</p>
        <div className="mode-grid">
          {modes.map((mode) => (
            <div className="mode-card" id={mode.id} key={mode.id}>
              <div className="icon">{mode.icon}</div>
              <h2>{mode.title}</h2>
              <p>{mode.description}</p>
            </div>
          ))}
        </div>
        <section className="how-to-play" aria-labelledby="how-to-play-title">
          <div className="how-to-heading">
            <span className="icon" aria-hidden="true">
              🎮
            </span>
            <h2 id="how-to-play-title">How to Play</h2>
          </div>
          <div className="how-to-grid">
            <article>
              <h3>Movement</h3>
              <p>
                How to move around in Disaster Sim and Construction Mode: Q to move up. E to move
                down. W, A, S, D to move around. Two fingers scroll to zoom in and out. Arrow keys
                to look around.
              </p>
              <p>
                How to move in Survival Mode: W, A, S, D to move around. Arrow keys to look around.
              </p>
            </article>
            <article>
              <h3>Modes</h3>
              <p>
                Simulator is the full sandbox. Build a town, switch tools, trigger disasters, and
                watch the world react.
              </p>
              <p>
                Survival puts you inside the world while disasters keep coming. Construction lets
                you place building sites and watch crews, cranes, trucks, and materials build them.
              </p>
            </article>
            <article>
              <h3>Build</h3>
              <p>
                Build tools place houses, towers, trees, lamps, people, builders, animals, rivers,
                islands, ships, mountains, and more. Builders gather lumber and raise houses, lamps
                light the village at night, and ships can battle nearby ships.
              </p>
            </article>
            <article>
              <h3>Destruction</h3>
              <p>
                Destroy tools summon hazards like fire, vortex storms, tornadoes, whirlpools,
                quakes, tsunamis, volcanoes, lava floods, bombs, meteors, black holes, monsters, and
                alien attacks. Each one damages the world differently.
              </p>
            </article>
            <article className="wide">
              <h3>Tips</h3>
              <p>
                Start by building a village, then test one disaster at a time. Rivers and islands
                can change how danger spreads. Use Generate, Ocean, and Generate Village for quick
                setups, Day/Night to change the mood, Toggle UI for more screen space, and Reset when
                you want a clean world.
              </p>
            </article>
          </div>
        </section>
      </div>

      <div id="survival-type-screen" className="overlay-screen hidden">
        <button className="back-btn" id="btn-back-modes">
          ← Back
        </button>
        <h1>Survival</h1>
        <p className="tagline">Choose how intense the world should be.</p>
        <div className="mode-grid survival-type-grid">
          <div className="mode-card survival-type-card" id="survival-destructive">
            <div className="icon">💥</div>
            <h2>Destructive</h2>
            <p>Classic Survival. Disasters and attacks keep coming while you try to last.</p>
          </div>
          <div className="mode-card survival-type-card" id="survival-peaceful">
            <div className="icon">🌿</div>
            <h2>Peaceful</h2>
            <p>Same world, movement, and inventory, but without attacks.</p>
          </div>
        </div>
      </div>

      <div id="survival-difficulty-screen" className="overlay-screen hidden">
        <button className="back-btn" id="btn-back-survival-types">
          ← Back
        </button>
        <h1>Destructive Survival</h1>
        <p className="tagline">Choose how often destruction appears and how much HP it can take.</p>
        <div className="mode-grid survival-difficulty-grid">
          <div className="mode-card survival-difficulty-card" id="survival-easy">
            <div className="icon">🟢</div>
            <h2>Easy</h2>
            <p>Destruction appears every 1-2 minutes. Damage: -1 to -10 HP.</p>
          </div>
          <div className="mode-card survival-difficulty-card" id="survival-normal">
            <div className="icon">🟡</div>
            <h2>Normal</h2>
            <p>Destruction appears every 30-60 seconds. Damage: -5 to -20 HP.</p>
          </div>
          <div className="mode-card survival-difficulty-card" id="survival-hard">
            <div className="icon">🔴</div>
            <h2>Hard</h2>
            <p>Destruction appears every 5-10 seconds. Damage: -10 to -50 HP.</p>
          </div>
          <div className="mode-card survival-difficulty-card" id="survival-impossible">
            <div className="icon">☠️</div>
            <h2>Impossible</h2>
            <p>Destruction appears every 2-5 seconds. Damage: -20 to -100 HP.</p>
          </div>
        </div>
      </div>
    </>
  );
}
