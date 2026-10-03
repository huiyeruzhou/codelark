/** 来自可见 DOM 的状态；这里只决定点击哪个公开控件，不读取或写入应用内部状态。 */
export interface OnboardingScreen {
  progress: string | null;
  role: boolean;
  engineering: boolean;
  personalized: boolean | null;
  dialog: string | null;
  buttons: string[];
  composer: boolean;
}

export function onboardingAction(screen: OnboardingScreen): string | false {
  const has = (label: string) => screen.buttons.includes(label);
  if (screen.dialog !== null) {
    // 对话框出现时，不能点击其后面的 Skip，也不能接受未知权限或登录提示。
    if (!/Skip setup\?|Finish set up and get/.test(screen.dialog)) return false;
    return has('Go to ChatGPT') ? 'Go to ChatGPT' : has('Skip') ? 'Skip' : false;
  }
  if (screen.role) {
    if (!screen.engineering) return 'Engineering';
    if (screen.personalized === true) return 'Suggest personalized tasks';
    return screen.personalized === false && has('Continue') ? 'Continue' : false;
  }
  if (screen.progress === null) return screen.composer ? 'done' : false;
  return ['Not now', 'Skip', 'Get Started'].find(has) || false;
}
