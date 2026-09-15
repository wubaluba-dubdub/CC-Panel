import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const ccPanelVolume = volume("cc-panel-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 500 });
  const CCPanel = service("CC-Panel", {
    source: github("wubaluba-dubdub/CC-Panel", { branch: "master", commitSha: "94a192eb171d1d7c3f1e96c9f5c0bc6564633e8e", upstreamUrl: "https://github.com/wubaluba-dubdub/CC-Panel" }),
    build: { builder: "DOCKERFILE" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: { "ams": 1 },
    networking: { privateNetworkEndpoint: "cc-panel" },
    volumeMounts: { "/data": ccPanelVolume },
    env: { PANEL_MASTER_KEY: preserve(), PANEL_NOTIFY_LOCALE: preserve(), PANEL_PUBLIC_URL: preserve(), RAILWAY_RUN_UID: preserve() },
  });

  return project("sweet-nourishment", {
    resources: [CCPanel, ccPanelVolume],
  });
});
