'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timedSegments, layoutSegments, buildTimelineResource, dayOffset, snapMinute } = require('../src/lib/timeline-utils');

function event(id, start, end) {
  return { id, calendarId: 'team', summary: 'Встреча', start: { dateTime: new Date(start).toISOString(), timeZone: 'Europe/Moscow' }, end: { dateTime: new Date(end).toISOString(), timeZone: 'Europe/Moscow' }, attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }] };
}

test('таймлайн обрезает ночную встречу по границам дня и не показывает соседние события', () => {
  const night = event('night', '2026-10-03T23:30', '2026-10-04T01:00');
  const past = event('past', '2026-10-02T10:00', '2026-10-02T11:00');
  const first = timedSegments([night, past], new Date('2026-10-03T12:00'));
  assert.deepEqual(first.map(({ startMinute, endMinute, startsHere, endsHere }) => ({ startMinute, endMinute, startsHere, endsHere })), [{ startMinute: 1410, endMinute: 1440, startsHere: true, endsHere: false }]);
  const second = timedSegments([night], new Date('2026-10-04T00:00'));
  assert.equal(second[0].startMinute, 0);
  assert.equal(second[0].endMinute, 60);
  assert.equal(second[0].endsHere, true);
  assert.equal(timedSegments([night], new Date('2026-10-05T00:00')).length, 0);
});

test('соседние встречи не пересекаются, одновременные используют отдельные колонки', () => {
  const segments = [
    { startMinute: 600, endMinute: 720 },
    { startMinute: 615, endMinute: 645 },
    { startMinute: 630, endMinute: 675 },
    { startMinute: 675, endMinute: 700 },
    { startMinute: 720, endMinute: 780 }
  ];
  const layout = layoutSegments(segments);
  assert.deepEqual(layout.map((segment) => segment.columns), [3, 3, 3, 3, 1]);
  assert.equal(layout[3].column, 1);
  for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) {
    if (layout[i].startMinute < layout[j].endMinute && layout[j].startMinute < layout[i].endMinute) assert.notEqual(layout[i].column, layout[j].column);
  }
  assert.equal(segments[0].column, undefined);
});

test('перенос через полночь сохраняет длительность, часовые пояса и не заменяет гостей', () => {
  const source = event('meeting', '2026-10-03T22:45', '2026-10-04T00:15');
  const snapshot = JSON.stringify(source);
  const resource = buildTimelineResource(source, { kind: 'move', days: 1, minutes: 60 });
  assert.equal(new Date(resource.start.dateTime).getDate(), 4);
  assert.equal(new Date(resource.start.dateTime).getHours(), 23);
  assert.equal(new Date(resource.end.dateTime).getDate(), 5);
  assert.equal(new Date(resource.end.dateTime) - new Date(resource.start.dateTime), 90 * 60000);
  assert.equal(resource.start.timeZone, 'Europe/Moscow');
  assert.equal(resource.end.timeZone, 'Europe/Moscow');
  assert.deepEqual(Object.keys(resource), ['start', 'end']);
  assert.equal(JSON.stringify(source), snapshot);
});

test('нижний край меняет только окончание и ограничивает длительность 15 минутами', () => {
  const source = event('meeting', '2026-10-03T10:00', '2026-10-03T11:00');
  const longer = buildTimelineResource(source, { kind: 'resize', minutes: 45 });
  assert.equal(longer.start.dateTime, source.start.dateTime);
  assert.equal(new Date(longer.end.dateTime) - new Date(longer.start.dateTime), 105 * 60000);
  const shorter = buildTimelineResource(source, { kind: 'resize', minutes: -120 });
  assert.equal(new Date(shorter.end.dateTime) - new Date(shorter.start.dateTime), 15 * 60000);
  const midnight = buildTimelineResource(source, { kind: 'resize', days: 1, minutes: -660 });
  assert.equal(new Date(midnight.end.dateTime).getDate(), 4);
  assert.equal(new Date(midnight.end.dateTime).getHours(), 0);
});

test('неизменённое короткое событие сохраняет длительность, неверные данные отклоняются', () => {
  const short = event('short', '2026-10-03T10:00', '2026-10-03T10:05');
  assert.equal(buildTimelineResource(short, { kind: 'resize' }).end.dateTime, short.end.dateTime);
  assert.throws(() => buildTimelineResource({ start: { date: '2026-10-03' } }, { kind: 'move' }), /со временем/);
  assert.throws(() => buildTimelineResource(short, { kind: 'wrong' }), /Некорректное/);
  assert.throws(() => buildTimelineResource(short, { kind: 'move', days: NaN }), /Некорректное/);
  assert.throws(() => buildTimelineResource({ start: { dateTime: 'bad' }, end: short.end }, { kind: 'move' }), /длительность/);
});

test('шаг времени и перенос между днями корректны через границу месяца', () => {
  assert.equal(snapMinute(607), 600);
  assert.equal(snapMinute(608), 615);
  assert.equal(dayOffset(new Date('2026-09-30T00:00'), new Date('2026-10-02T00:00')), 2);
  assert.equal(dayOffset(new Date('2026-10-02T00:00'), new Date('2026-09-30T00:00')), -2);
});

test('привязка к сетке убирает секунды исходной встречи без сдвига на минуту', () => {
  const source = event('seconds', '2026-10-03T09:00:30', '2026-10-03T10:00:30');
  const moved = buildTimelineResource(source, { kind: 'move', minutes: 59.5 });
  assert.equal(new Date(moved.start.dateTime).getHours(), 10);
  assert.equal(new Date(moved.start.dateTime).getMinutes(), 0);
  assert.equal(new Date(moved.start.dateTime).getSeconds(), 0);
  const resized = buildTimelineResource(source, { kind: 'resize', minutes: -15.5 });
  assert.equal(new Date(resized.end.dateTime).getHours(), 9);
  assert.equal(new Date(resized.end.dateTime).getMinutes(), 45);
  assert.equal(new Date(resized.end.dateTime).getSeconds(), 0);
});

test('перенос на день через переход на летнее время сохраняет часы и длительность', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const {buildTimelineResource,dayOffset}=require('./src/lib/timeline-utils');
    const start=new Date('2026-03-07T09:00'); const end=new Date('2026-03-07T11:00');
    const result=buildTimelineResource({start:{dateTime:start.toISOString()},end:{dateTime:end.toISOString()}},{kind:'move',days:1});
    const movedStart=new Date(result.start.dateTime); const movedEnd=new Date(result.end.dateTime);
    console.log(JSON.stringify({hour:movedStart.getHours(),date:movedStart.getDate(),duration:movedEnd-movedStart,offset:dayOffset(start,movedStart),elapsed:movedStart-start}));`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hour: 9, date: 8, duration: 7200000, offset: 1, elapsed: 23 * 3600000 });
});
