import { db } from '../store.mjs';
import { el, esc, fmt } from '../ui.mjs';

// Счётчики последней сверки приходят объектом; раньше он печатался как сырой
// JSON прямо посреди предложения.
const COUNT_RU = {
  supports: 'карт всего', supportsGlobal: 'карт на Global',
  outfits: 'нарядов всего', outfitsGlobal: 'нарядов на Global',
  characters: 'ум', skills: 'скиллов',
};
const countsRu = (counts) => Object.entries(counts)
  .map(([k, v]) => `${COUNT_RU[k] ?? k}: ${v}`)
  .join(', ');

export function renderData(root) {
  const m = db.meta;
  const when = m.generatedAt ? new Date(m.generatedAt) : null;
  const gt = m.gametora ?? {};

  const counts = [
    ['Скиллов на Global', m.counts?.learnableSkills],
    ['Ум', m.counts?.characters],
    ['Нарядов', m.counts?.outfits],
    ['Карт поддержки на Global', m.counts?.supports],
    ['Карт поддержки известно всего', m.counts?.supportsAll],
    ['Курсов', m.counts?.courses],
  ];

  const jpOnly = db.supports.filter((s) => !s.global).length;
  const unverified = db.supports.filter((s) => s.global && s.unverified).length;
  const hiddenOutfits = m.counts?.outfitsHidden ?? 0;

  root.replaceChildren(el(`<div class="layout" style="grid-template-columns:minmax(0,1fr)">
    <section class="stack" style="max-width:820px">
      <div class="page-head">
        <div>
          <h1>Откуда берутся данные</h1>
          <p>Последняя пересборка: ${when ? esc(when.toLocaleString('ru-RU')) : 'неизвестно'}.</p>
        </div>
      </div>

      <div class="plan-grid">
        ${counts.map(([label, n]) => `
          <div class="stat-tile">
            <h4>${esc(label)}</h4>
            <div class="big">${n == null ? '—' : fmt.int(n)}</div>
          </div>`).join('')}
      </div>

      <section class="panel">
        <div class="panel__head"><h3>Источники</h3></div>
        <div class="panel__body">
          <p><b>Мастер-база клиента Global.</b> Идентификаторы, названия, аптитюды, условия и эффекты скиллов, геометрия
          курсов читаются из дампа мастер-базы <i>глобального</i> клиента, который публикует
          <a href="https://github.com/alpha123/uma-tools" style="color:var(--accent)">alpha123/uma-tools</a>. Дамп снят
          именно с Global, а не с японского клиента, поэтому всё, что в нём есть, по определению уже вышло на Global —
          на этом и построен фильтр релизов.</p>
          <p style="margin-top:8px"><b>GameTora.</b> Задача обновления также сверяется с
          <a href="https://gametora.com/umamusume" style="color:var(--accent)">gametora.com</a> — за датами релизов и
          каноническим написанием названий на Global. Статус последней попытки:
          <b>${gt.ok ? 'успех' : 'не применено'}</b>${gt.counts ? ` (${esc(countsRu(gt.counts))})` : ''}.
          Когда сверка не применяется, работает только фильтр по мастер-базе, а названия остаются такими, как в клиенте
          Global — то есть в той же формулировке, что показывает GameTora.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>Как решается, что карта «есть на Global»</h3></div>
        <div class="panel__body">
          <p>Умы, скиллы и курсы приходят прямо из дампа Global, поэтому их фильтровать не нужно.</p>
          <p style="margin-top:8px">Карты поддержки публикуются одним общим списком, поэтому каждая проверяется по набору
          скиллов Global: карта считается вышедшей, если каждый скилл, которому она учит — ивент-скилл и все хинты, —
          есть в клиенте Global. ${fmt.int(jpOnly)} карт эту проверку не проходят и спрятаны за переключателем
          <i>Только релизы Global</i> на странице «Карты поддержки».</p>
          <p style="margin-top:8px">Карты, которые проверку проходят, но находятся за текущей границей релизов Global,
          помечаются как <b>не проверено</b>, а не принимаются молча — сейчас таких ${fmt.int(unverified)}. Страница
          «Карты поддержки» умеет скрывать их одним переключателем.</p>
          <p style="margin-top:8px">Умы приходят прямо из дампа Global, но клиент завозит данные карт чуть раньше баннера,
          поэтому наряд может появиться до того, как в него можно играть.
          ${hiddenOutfits ? `Сейчас ${fmt.int(hiddenOutfits)} нарядов вручную помечены как ещё не вышедшие.` : 'Сейчас ничего не помечено как невышедшее.'}</p>
          <p style="margin-top:8px" class="note">Оба списка правятся руками:
          <code>data-overrides/supports.json</code> и <code>data-overrides/characters.json</code> закрепляют любую карту
          или наряд в любую сторону, а когда сверка с GameTora удалась, её даты релизов важнее вывода по скиллам. Если
          заметишь на сайте то, чего на Global ещё нет, — это тот самый файл.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>Что означают числа</h3></div>
        <div class="panel__body">
          <p><b>Условия срабатывания</b> собраны из сырых выражений в игровых данных, а не из описаний, поэтому они говорят
          ровно то, что проверяет движок.</p>
          <p style="margin-top:8px"><b>Нужно Stamina</b> в планировщике решается из стандартной модели HP: базовая скорость
          от дистанции, целевые скорости по фазам от стиля бега, скорость последнего спурта от Speed и Guts и расход HP
          <code>20·(v − base + 12)² / 144</code> в секунду с множителем Guts на финальном отрезке.
          Соперницы, позиционирование и ускорения темпа не учитываются, так что читай это как нижнюю границу
          выносливости, чтобы просто добежать свой забег.</p>
          <p style="margin-top:8px"><b>Очки скиллов</b> — это ожидаемые <b>корпуса</b>, выигранные на выбранном курсе. Окно
          срабатывания пересекается с реальной геометрией трассы, длительность эффекта обрезается расстоянием до линии,
          а результат умножается на шанс выполнения условия по позиции в поле из 9 участниц Champions Meeting, на бросок
          срабатывания Wit (<code>100 − 9000 / Wit</code>) и на штраф за условия вроде «зажали в коробке». Открой любой
          скилл, чтобы увидеть все эти числа именно для него.</p>
          <p style="margin-top:8px"><b>Чувствительность к статам</b> в планировщике — это конечная разность: забег
          прогоняется заново со 100 очками стата сверху, а сэкономленное время переводится в корпуса на финише. У Power
          там пусто намеренно: он отвечает за ускорение и смену дорожек, которые эта сборка не симулирует, и сделать вид,
          что мы его измерили, было бы хуже, чем честно сказать об этом.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>Чего здесь нет</h3></div>
        <div class="panel__body">
          <p>Тренировочных эффектов карт поддержки (бонус дружбы, шанс специализации, прирост статов), бонусов роста
          персонажей и вариантов в тренировочных ивентах в дампе мастер-базы, который читает эта сборка, нет — поэтому
          они не показаны. За ними по-прежнему на страницы самой GameTora.</p>
        </div>
      </section>
    </section>
  </div>`));
}
