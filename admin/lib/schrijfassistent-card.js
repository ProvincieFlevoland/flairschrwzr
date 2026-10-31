// Schrijfassistent launcher card.
//
// The card lives in admin/defaults/apps.json (git): `target: "schrijfassistent"`, url "/", config with api_base_url,
// asset_base_url and b1_metrics_doc_url. The embedded app is the only way to open it, for every authenticated user.
// The card has no mode and no list of users.
//
// Pure functions only: no fs, no express. server.js requires this module and
// admin/tests/card.test.mjs tests it directly.

const SCHRIJFASSISTENT_CARD_ID = "schrijfassistent";
// Local development only: the only api_base_url the local allowance can publish.
const LOCAL_API_BASE_URL_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?$/i;

// Returns a deep copy of appsData as it is published. `allow_local_api` is removed from the schrijfassistent card
// so nothing stored in apps.json (or typed into the admin apps editor) can switch it on; it is published as `true`
// only when `options.allowLocalApi === true`, which server.js derives from the environment variable
// SCHRIJFASSISTENT_ALLOW_LOCAL_API (docker-compose.local.yaml sets it, the pipeline never does). With the allowance,
// `options.localApiBaseUrl` replaces `api_base_url` when it is an http://localhost or http://127.0.0.1 URL; any other
// value is ignored. loader.js honours the field only when the page itself is served from localhost. The fields
// mode, embedded_for_emails and embedded_for_roles are never published; they are dropped from the card's config.
function prepareAppsForPublish(appsData, options) {
  const data = appsData && typeof appsData === "object" ? JSON.parse(JSON.stringify(appsData)) : appsData;
  if (!data || !Array.isArray(data.apps)) return data;
  for (const app of data.apps) {
    if (!app || app.id !== SCHRIJFASSISTENT_CARD_ID) continue;
    const config = app.config && typeof app.config === "object" ? { ...app.config } : {};
    delete config.mode;
    delete config.embedded_for_emails;
    delete config.embedded_for_roles;
    delete config.allow_local_api;
    if (options && options.allowLocalApi === true) {
      config.allow_local_api = true;
      const localUrl = String(options.localApiBaseUrl || "").trim();
      if (LOCAL_API_BASE_URL_PATTERN.test(localUrl)) config.api_base_url = localUrl.replace(/\/+$/, "");
    }
    app.config = config;
  }
  return data;
}

function findSchrijfassistentCard(appsData) {
  if (!appsData || !Array.isArray(appsData.apps)) return null;
  return appsData.apps.find((a) => a && a.id === SCHRIJFASSISTENT_CARD_ID) || null;
}

// JSON for an inline <script> or a JSON script block: `<`, `>`, `&` and the
// line separators are written as \uXXXX so `</script>` cannot occur and the
// result is still valid JSON and valid JavaScript.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

module.exports = {
  SCHRIJFASSISTENT_CARD_ID,
  LOCAL_API_BASE_URL_PATTERN,
  prepareAppsForPublish,
  findSchrijfassistentCard,
  jsonForScript,
};
