import {createContext} from "react";
import {workbenchPreferencesSchema,type WorkbenchPreferences} from "@codexdeck/shared";
export const AppearanceContext=createContext<{prefs:WorkbenchPreferences;update:(patch:Partial<WorkbenchPreferences>)=>void}>({
  prefs:workbenchPreferencesSchema.parse({}),update:()=>{},
});
