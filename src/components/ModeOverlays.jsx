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
      <div id="start-screen" className="overlay-screen">
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
      </div>
    </>
  );
}
