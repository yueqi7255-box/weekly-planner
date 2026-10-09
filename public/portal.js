function isoWeekInfo(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  return { year, week: Math.ceil((((day - yearStart) / 86400000) + 1) / 7) };
}

const { year, week } = isoWeekInfo(new Date());
const totalWeeks = isoWeekInfo(new Date(year, 11, 28)).week;
document.getElementById('portal-year').textContent = year;
document.getElementById('current-week-label').textContent = `第 ${week} 周`;
const ticks = document.getElementById('week-ticks');
ticks.style.setProperty('--weeks', totalWeeks);
for (let number = 1; number <= totalWeeks; number += 1) {
  const tick = document.createElement('span');
  if (number === week) tick.className = 'current';
  ticks.append(tick);
}
