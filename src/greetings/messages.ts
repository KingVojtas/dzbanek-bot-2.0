export function welcomeMessage(mention: string): string {
  return (
    `🍪 Hey ${mention}! Welcome to the dark side, we have cookies. ` +
    `I’m Dzbanek — grab one, say hi, and don’t mind the crumbs. 😈`
  );
}

export function goodbyeMessage(username: string): string {
  return (
    `👋 ${username} just left the kitchen. Hasta la vista, baby! 🕶️🍪 ` +
    `We’ll keep a cookie warm in case they come back.`
  );
}
