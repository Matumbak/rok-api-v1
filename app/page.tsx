// Landing page for the API itself — discovery only. Real frontends are
// rok-landing and rok-admin.
export default function Home() {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, monospace",
        padding: "2rem",
        background: "#0a1014",
        color: "#e8dcc8",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ color: "#c97b3d" }}>rok-api</h1>
      <p>API for the 4028 Huns landing.</p>
      <ul>
        <li>
          <a href="/api/health" style={{ color: "#c97b3d" }}>
            /api/health
          </a>
        </li>
        <li>
          <a href="/api/requirements" style={{ color: "#c97b3d" }}>
            /api/requirements
          </a>
        </li>
        <li>
          <a href="/api/media" style={{ color: "#c97b3d" }}>
            /api/media
          </a>
        </li>
        <li>
          <a href="/api/dkp" style={{ color: "#c97b3d" }}>
            /api/dkp
          </a>
        </li>
      </ul>
    </main>
  );
}
