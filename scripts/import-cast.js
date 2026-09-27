// One-time, explicitly run import of the official CBS cast facts and photo URLs.
import { mkdir, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
const source = 'https://www.paramountplus.com/sneak-peak/survivor-season-51-cast/';
const response = await fetch(source);
if (!response.ok) throw new Error(`Cast source returned ${response.status}`);
const $ = cheerio.load(await response.text());
const toka = ['Aaliyah', 'An ', 'Angelica', 'Brady', 'Danny', 'Devin', 'Jenna', 'Maggie', 'Mike', 'Patt'];
const cast = $('h3').toArray().slice(0, 21).map(el => {
  const name = $(el).text().trim();
  const section = $(el).nextUntil('h3');
  const facts = section.find('li').toArray().map(li => $(li).text().trim());
  const value = label => facts.find(f => f.startsWith(label))?.split(':').slice(1).join(':').trim() || '';
  return {
    id: name.toLowerCase().replace(/[“”]/g, '').replace(/[^a-z0-9]+/g, '-'), name,
    shortName: name.includes('Thien An') ? 'Thien An' : name.includes('Jelly') ? 'Jelly' : name.includes('Kilby') ? 'Kilby' : name.split(' ')[0],
    age: Number(value('Age')), occupation: value('Occupation'),
    hometown: value('Current residence') || value('Hometown/current residence') || value('Hometown'),
    tribe: name.startsWith('Lewis') ? 'Exile' : toka.some(n => name.startsWith(n)) ? 'Toka' : 'Savu',
    image: new URL(section.find('img').first().attr('src'), source).href,
    placement: name.startsWith('Aaliyah') ? 21 : null,
    bonuses: { immunityWin: 0, idolFound: name.startsWith('Rob ') ? 1 : 0, idolPlayed: 0 },
  };
});
if (cast.length !== 21 || cast.some(c => !c.name || !c.age || !c.image)) throw new Error('Incomplete cast; refusing to write');
await mkdir(new URL('../data/s51/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/s51/contestants.json', import.meta.url), JSON.stringify(cast, null, 2) + '\n');
console.log(`Imported ${cast.length} castaways from CBS.`);
