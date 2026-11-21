export async function openTools(page) {
  const toggle = page.getByRole("button", {name:"工具与设置",exact:true});
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const navigation = page.getByRole("navigation", {name:"模块导航"});
  await navigation.waitFor();
  return navigation;
}

export async function selectTool(page, name) {
  const navigation = await openTools(page);
  await navigation.getByRole("button", {name,exact:true}).click();
  await navigation.waitFor({state:"hidden"});
}
