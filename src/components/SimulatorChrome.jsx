const buildTools = [
  ["btn-house", "btn-blue active", "🏠", "House"],
  ["btn-skyscraper", "btn-blue", "🏢", "Tower"],
  ["btn-tree", "btn-green", "🌲", "Tree"],
  ["btn-human", "btn-orange", "🏃", "Resident"],
  ["btn-builder", "btn-orange", "👷", "Builder"],
  ["btn-invader", "btn-red", "🏹", "Invader"],
  ["btn-animal", "btn-green", "🦌", "Animal"],
  ["btn-river", "btn-blue", "🏞️", "River"],
  ["btn-mountain", "btn-gray", "⛰️", "Mountain"],
  ["btn-eraser", "btn-gray", "🧹", "Eraser"],
];

const destroyTools = [
  ["btn-fire", "🔥", "Fire"],
  ["btn-vortex", "🌪️", "Tornado"],
  ["btn-quake", "🫨", "Quake"],
  ["btn-tsunami", "🌊", "Tsunami"],
  ["btn-volcano", "🌋", "Volcano"],
  ["btn-lavaflood", "🪣", "Lava Flood"],
  ["btn-napalm", "⛽", "Napalm"],
  ["btn-cluster", "💣", "Cluster"],
  ["btn-nuke", "☢️", "Nuke"],
  ["btn-meteor", "☄️", "Meteor"],
  ["btn-blackhole", "🕳️", "Black Hole"],
  ["btn-cracker", "🪨", "Cracker"],
  ["btn-leviathan", "🐉", "Leviathan"],
  ["btn-kraken", "🦑", "Kraken"],
];

function ToolButton({ id, className, icon, label }) {
  return (
    <button id={id} className={`tool ${className}`}>
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function SimulatorChrome() {
  return (
    <>
      <div id="header" style={{ display: "none" }}>
        <div id="title">🌍 Disaster Sim</div>
        <div id="header-actions">
          <button id="btn-generate" className="header-btn" aria-label="Generate Terrain">
            🌱 Generate
          </button>
          <button id="btn-village" className="header-btn" aria-label="Random Village">
            🏘️ Village
          </button>
          <button id="btn-daynight" className="header-btn" aria-label="Toggle Day/Night">
            ☀️
          </button>
          <button id="btn-toggle" className="header-btn" aria-label="Toggle UI">
            ⚙️
          </button>
          <button id="btn-clear" className="header-btn purge" aria-label="Reset">
            ♻️ Reset
          </button>
          <button id="btn-exit-sim" className="header-btn" aria-label="Exit to Menu">
            🚪 Exit
          </button>
        </div>
      </div>

      <div id="toolbar" style={{ display: "none" }}>
        <div id="handle">
          <div id="handle-bar" />
        </div>
        <div id="tabs">
          <button className="tab active" data-tab="build">
            🏗️ Build
          </button>
          <button className="tab" data-tab="destroy">
            💥 Destroy
          </button>
        </div>

        <div id="tray-build" className="tray active">
          {buildTools.map(([id, className, icon, label]) => (
            <ToolButton id={id} className={className} icon={icon} label={label} key={id} />
          ))}
        </div>

        <div id="tray-destroy" className="tray">
          {destroyTools.map(([id, icon, label]) => (
            <ToolButton id={id} className="btn-red" icon={icon} label={label} key={id} />
          ))}
        </div>
      </div>
    </>
  );
}
