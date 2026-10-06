// Thin application-facing wrapper around script-workspace.js.
// The large workspace implementation remains isolated; this module owns its
// construction and exposes one startup entry point to app.js.

import {createScriptWorkspace} from "./script-workspace.js";

export function createScriptUI(deps){
  const workspace=createScriptWorkspace(deps);

  function initializeScriptWorkspaceUI(){
    workspace.initializeTimeEstimateUI();
    workspace.initializeScriptUI();
  }

  return {
    ...workspace,
    initializeScriptWorkspaceUI
  };
}
