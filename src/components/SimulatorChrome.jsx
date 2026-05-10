const buildTools = [
  ["btn-house", "btn-blue active", "🏠", "House"],
  ["btn-skyscraper", "btn-blue", "🏢", "Tower"],
  ["btn-tree", "btn-green", "🌲", "Tree"],
  ["btn-streetlamp", "btn-orange", "💡", "Street Lamp"],
  ["btn-human", "btn-orange", "🏃", "Resident"],
  ["btn-builder", "btn-orange", "👷", "Builder"],
  ["btn-invader", "btn-red", "🏹", "Invader"],
  ["btn-animal", "btn-green", "🦌", "Animal"],
  ["btn-river", "btn-blue", "🏞️", "River"],
  ["btn-island", "btn-green", "🏝️", "Island"],
  ["btn-ship", "btn-orange", "⛵", "1930s Ship"],
  ["btn-mountain", "btn-gray", "⛰️", "Mountain"],
  ["btn-eraser", "btn-gray", "🧹", "Eraser"],
];

const destroyTools = [
  ["btn-fire", "🔥", "Fire"],
  ["btn-vortex", "☁️", "Vortex"],
  ["btn-tornado", "🌪️", "Tornado"],
  ["btn-whirlpool", "🌀", "Whirlpool"],
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
  ["btn-battleship", "🛸", "Battleship"],
  ["btn-mothership", "🛸", "Mothership"],
  ["btn-leviathan", "🐉", "Leviathan"],
  ["btn-kraken", "🦑", "Kraken"],
  ["btn-maw", "🦷", "Maw"],
  ["btn-human-eater", "🌿", "Human Eater"],
  ["btn-titanx", "🐍", "Sky Leviathan"],
];

function ToolButton({ id, className, icon, label }) {
  return (
    <button id={id} className={`tool ${className}`}>
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function HeaderButton({ id, icon, label, className = "" }) {
  return (
    <button id={id} className={`header-btn ${className}`} title={label} aria-label={label}>
      <span className="icon">{icon}</span>
      <span className="btn-label">{label}</span>
    </button>
  );
}

export function SimulatorChrome() {
  return (
    <>
      <div id="header" style={{ display: "none" }}>
        <div id="title">
          <span className="icon">🌍</span>
          <span>Disaster Sim</span>
        </div>
        <div id="header-actions">
          <HeaderButton id="btn-generate" icon="🌱" label="Generate" />
          <HeaderButton id="btn-ocean" icon="🌊" label="Ocean" />
          <HeaderButton id="btn-village" icon="🏘️" label="Generate Village" />
          <HeaderButton id="btn-relocate" icon="📍" label="Relocate" />
          <HeaderButton id="btn-daynight" icon="☀️" label="Day/Night" />
          <HeaderButton id="btn-toggle" icon="⚙️" label="Toggle UI" />
          <HeaderButton id="btn-clear" icon="♻️" label="Reset" className="purge" />
          <HeaderButton id="btn-exit-sim" icon="🚪" label="Exit" />
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
