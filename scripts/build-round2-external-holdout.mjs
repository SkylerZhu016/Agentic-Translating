import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'external-holdout-v1',
)
const outputPath = path.join(outputDir, 'external-holdout.jsonl')
const translatorInputPath = path.join(outputDir, 'direct-translator-input.jsonl')
const sourcesPath = path.join(outputDir, 'SOURCES.md')

const samples = [
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-en-zh-dickinson-slant-light',
    direction: 'en_to_zh',
    category: 'poetry',
    sourceForm: 'poetry',
    genre: 'lyric poem',
    era: 'modern',
    canonicality: 'high',
    sourceText: `There's a certain slant of light,
On winter afternoons,
That oppresses, like the weight
Of cathedral tunes.

Heavenly hurt it gives us;
We can find no scar,
But internal difference
Where the meanings are.

None may teach it anything,
'T is the seal, despair,—
An imperial affliction
Sent us of the air.

When it comes, the landscape listens,
Shadows hold their breath;
When it goes, 't is like the distance
On the look of death.`,
    taskBrief:
      '将全诗译为凝练、可诵读的中文诗。保留四节、十六行、冬日下午的斜光、宗教音乐的重量、无形内伤与末节由静止通向死亡神情的距离感。原文已有破折号时可以传达其停顿；不要在其他位置另加破折号或分号。形式服务于意义，不为押韵增添原文没有的解释。',
    difficultyTags: [
      'abstract-imagery',
      'religious-register',
      'semantic-ambiguity',
      'punctuation-rhythm',
    ],
    deterministicConstraints: {
      preserveLineBreaks: true,
      preserveStanzas: true,
      expectedStanzas: 4,
      expectedNonEmptyLines: 16,
    },
    source: {
      author: 'Emily Dickinson',
      title: "There's a certain slant of light",
      year: 1890,
      edition:
        'Poems by Emily Dickinson, first series (1890), Wikisource transcription',
      url: "https://en.wikisource.org/wiki/Poems_(Dickinson)/There%27s_a_certain_slant_of_light",
      excerptBounds: 'Complete poem, all four stanzas and 16 lines.',
      rightsBasis:
        'The poem and 1890 edition are in the public domain; the cited Wikisource transcription is available under CC BY-SA 4.0.',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    reviewerChecklist: [
      'Whether the translation preserves the uncertain relation among light, cathedral music, hurt and meaning instead of explaining it away.',
      'Whether “seal, despair” and “imperial affliction” retain their compressed religious and political force.',
      'Whether the final distance belongs to the look of death rather than becoming a generic description of death.',
      'Whether the Chinese lineation and pauses remain readable without gratuitous punctuation.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-en-zh-saki-open-window',
    direction: 'en_to_zh',
    category: 'literary',
    sourceForm: 'english_prose',
    genre: 'comic short-story narration and dialogue',
    era: 'modern',
    canonicality: 'medium',
    sourceText: `“My aunt will be down presently, Mr. Nuttel,” said a very self-possessed young lady of fifteen; “in the meantime you must try and put up with me.”

Framton Nuttel endeavoured to say the correct something which should duly flatter the niece of the moment without unduly discounting the aunt that was to come. Privately he doubted more than ever whether these formal visits on a succession of total strangers would do much towards helping the nerve cure which he was supposed to be undergoing.

“I know how it will be,” his sister had said when he was preparing to migrate to this rural retreat; “you will bury yourself down there and not speak to a living soul, and your nerves will be worse than ever from moping. I shall just give you letters of introduction to all the people I know there. Some of them, as far as I can remember, were quite nice.”

Framton wondered whether Mrs. Sappleton, the lady to whom he was presenting one of the letters of introduction, came into the nice division.

“Do you know many of the people round here?” asked the niece, when she judged that they had had sufficient silent communion.

“Hardly a soul,” said Framton. “My sister was staying here, at the rectory, you know, some four years ago, and she gave me letters of introduction to some of the people here.”`,
    taskBrief:
      '译为自然、克制而有讽刺节奏的现代中文小说。保留六段、对话礼貌中的控制感、叙述者对社交礼仪的揶揄和 Framton 的紧张。人名与社会称谓保持一致，不把幽默改写成解释。',
    difficultyTags: [
      'dry-humour',
      'narrative-distance',
      'dialogue-register',
      'social-irony',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 6,
    },
    source: {
      author: 'H. H. Munro (Saki)',
      title: 'The Open Window',
      year: 1914,
      edition:
        'Beasts and Super-Beasts, John Lane (1914), Project Gutenberg eBook #269',
      url: 'https://www.gutenberg.org/cache/epub/269/pg269-images.html#THE_OPEN_WINDOW',
      excerptBounds:
        'Opening six complete paragraphs, ending with Framton’s account of his sister’s introductions.',
      rightsBasis:
        'The 1914 work is in the public domain in the United States; Project Gutenberg identifies the edition as public domain in the USA.',
      licenseUrl: 'https://www.gutenberg.org/policy/license.html',
    },
    reviewerChecklist: [
      'Whether “the correct something” and “discounting the aunt” preserve the narrator’s dry social irony.',
      'Whether “nerve cure,” “moping,” and “letters of introduction” fit the period without sounding like a medical report.',
      'Whether the niece’s composure and Framton’s unease remain distinct voices.',
      'Whether Framton’s final spoken account retains his social discomfort beneath its conventional wording.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-en-zh-emerson-self-reliance',
    direction: 'en_to_zh',
    category: 'cultural_argument',
    sourceForm: 'english_prose',
    genre: 'philosophical essay',
    era: 'modern',
    canonicality: 'high',
    sourceText: `I read the other day some verses written by an eminent painter which were original and not conventional. The soul always hears an admonition in such lines, let the subject be what it may. The sentiment they instil is of more value than any thought they may contain. To believe your own thought, to believe that what is true for you in your private heart is true for all men,—that is genius.

Speak your latent conviction, and it shall be the universal sense; for the inmost in due time becomes the outmost, and our first thought is rendered back to us by the trumpets of the Last Judgment. Familiar as the voice of the mind is to each, the highest merit we ascribe to Moses, Plato and Milton is that they set at naught books and traditions, and spoke not what men, but what they thought.

A man should learn to detect and watch that gleam of light which flashes across his mind from within, more than the lustre of the firmament of bards and sages. Yet he dismisses without notice his thought, because it is his. In every work of genius we recognize our own rejected thoughts; they come back to us with a certain alienated majesty.`,
    taskBrief:
      '译为论证清晰、气势连贯的现代中文思想随笔。保留三段、内在思想由私人走向普遍的推演、宗教与经典人物典故，以及作者兼具断言和劝诫的声音。避免把长句切成口号，也不要把 rhetorical force 夸写成煽情。',
    difficultyTags: [
      'philosophical-argument',
      'religious-allusion',
      'rhetorical-cadence',
      'abstract-terms',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 3,
    },
    source: {
      author: 'Ralph Waldo Emerson',
      title: 'Self-Reliance',
      year: 1841,
      edition:
        'Essays, First Series, Project Gutenberg eBook #2944, HTML edition',
      url: 'https://www.gutenberg.org/files/2944/2944-h/2944-h.htm#SELF-RELIANCE',
      excerptBounds:
        'Three complete opening argument paragraphs, from “I read the other day” through “alienated majesty.”',
      rightsBasis:
        'The 1841 essay is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
      licenseUrl: 'https://www.gutenberg.org/policy/license.html',
    },
    reviewerChecklist: [
      'Whether thought, sentiment, conviction and spontaneous impression remain meaningfully distinct.',
      'Whether the inmost/outmost movement and Last Judgment image preserve the argument’s logic.',
      'Whether the Moses, Plato and Milton sentence keeps its contrast between received authority and personal thought.',
      'Whether the Chinese prose sustains cumulative rhetoric without turning into disconnected slogans.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-en-zh-faraday-candle',
    direction: 'en_to_zh',
    category: 'nonliterary',
    sourceForm: 'english_prose',
    genre: 'public scientific lecture',
    era: 'modern',
    canonicality: 'medium',
    sourceText: `I purpose, in return for the honour you do us by coming to see what are our proceedings here, to bring before you, in the course of these lectures, the Chemical History of a Candle. I have taken this subject on a former occasion; and were it left to my own will, I should prefer to repeat it almost every year—so abundant is the interest that attaches itself to the subject, so wonderful are the varieties of outlet which it offers into the various departments of philosophy.

There is not a law under which any part of this universe is governed which does not come into play, and is touched upon in these phenomena. There is no better, there is no more open door by which you can enter into the study of natural philosophy, than by considering the physical phenomena of a candle. I trust, therefore, I shall not disappoint you in choosing this for my subject rather than any newer topic, which could not be better, were it even so good.

And before proceeding, let me say this also—that though our subject be so great, and our intention that of treating it honestly, seriously, and philosophically, yet I mean to pass away from all those who are seniors amongst us. I claim the privilege of speaking to juveniles as a juvenile myself. I have done so on former occasions—and, if you please, I shall do so again.`,
    taskBrief:
      '译为准确、清楚而保留现场感的中文科普演讲。保留三段、讲者对听众的礼貌、由蜡烛通往自然哲学的论证、十九世纪 scientific lecture 的庄重与亲切。philosophy 和 natural philosophy 要按历史语境处理；不得擅自改成现代学科结论。',
    difficultyTags: [
      'historical-scientific-register',
      'lecture-voice',
      'long-syntax',
      'terminology-context',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 3,
    },
    source: {
      author: 'Michael Faraday',
      title: 'The Chemical History of a Candle',
      year: 1861,
      edition:
        'Edited by William Crookes, Project Gutenberg eBook #14474, HTML edition updated 2024',
      url: 'https://www.gutenberg.org/cache/epub/14474/pg14474-images.html',
      excerptBounds:
        'Lecture I, first three complete paragraphs, beginning “I purpose” and ending “I shall do so again.”',
      rightsBasis:
        'The work is in the public domain in the United States; Project Gutenberg identifies eBook #14474 as public domain in the USA.',
      licenseUrl: 'https://www.gutenberg.org/policy/license.html',
    },
    reviewerChecklist: [
      'Whether “Chemical History,” “philosophy,” and “natural philosophy” are rendered in their historical scientific sense.',
      'Whether the universal-law claim remains a rhetorical bridge rather than a literal modern scientific overstatement.',
      'Whether the contrast between newer topics and the candle is logically intact.',
      'Whether the shift to addressing juveniles remains warm, dignified and spoken.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-zh-en-yanjidao-linjiangxian',
    direction: 'zh_to_en',
    category: 'poetry',
    sourceForm: 'poetry',
    genre: 'ci lyric',
    era: 'classical',
    canonicality: 'high',
    sourceText: `梦后楼台高锁，酒醒帘幕低垂。去年春恨却来时。落花人独立，微雨燕双飞。

记得小苹初见，两重心字罗衣。琵琶弦上说相思。当时明月在，曾照彩云归。`,
    taskBrief:
      'Translate the complete ci lyric into lyrical, natural English. Preserve its two stanzas, ten phrase-lines, movement between present solitude and remembered encounter, the paired image of a lone person and two swallows, and the moonlit return at the end. Treat Xiaoping as a personal name and the heart-patterned layered robe as a concrete but culturally marked image. Rhyme is optional and must not require invented meaning.',
    difficultyTags: [
      'ci-form',
      'temporal-layering',
      'parallel-imagery',
      'cultural-object',
    ],
    deterministicConstraints: {
      preserveLineBreaks: true,
      preserveStanzas: true,
      expectedStanzas: 2,
      expectedNonEmptyLines: 6,
    },
    source: {
      author: '晏几道',
      title: '临江仙·梦后楼台高锁',
      year: 1100,
      edition:
        '《小山词》通行本，古文岛简体页面；标点和简体字形按测试集统一规范',
      url: 'https://www.gushiwen.cn/GuShiWen_ec40f5ffaf.aspx',
      excerptBounds: '全词，两阕。',
      rightsBasis:
        '晏几道及其作品已进入公有领域；测试文本仅对通行古文作简体字形与现代标点整理。',
      licenseUrl: 'https://www.gushiwen.cn/',
    },
    reviewerChecklist: [
      'Whether “春恨却来时” keeps its returning temporal force instead of becoming a generic spring sadness.',
      'Whether the lone figure and paired swallows retain their visual and emotional contrast.',
      'Whether “两重心字罗衣” is concrete and intelligible without unsupported costume invention.',
      'Whether “彩云归” remains attached to remembered Xiaoping and the moonlit scene.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-zh-en-pusongling-ear-voice',
    direction: 'zh_to_en',
    category: 'literary',
    sourceForm: 'classical_chinese_prose',
    genre: 'strange-tale narration',
    era: 'early_modern',
    canonicality: 'low',
    sourceText:
      '谭晋玄，邑诸生也，笃信导引之术，寒暑不辍；行之数月，若有所得。一日，方趺坐，闻耳中小语如蝇，曰：“可以见矣。”开目即不复闻，合眸定息，又闻如故。谓是丹将成，窃喜。自是每坐辄闻，因俟其再言，当应以觇之。一日，又言。乃微应曰：“可以见矣。”俄觉耳中习习然，似有物出。',
    contextAfter:
      'The episode continues with a tiny uncanny figure emerging; this context is metadata and is not part of the text to translate.',
    taskBrief:
      'Translate this complete excerpt into lucid literary English with a restrained uncanny tone. Preserve the compressed chronology, the technical vocabulary of Daoist breath cultivation without overexplaining it, the repeated whispered sentence, and the narrator’s calm distance from Tan’s private excitement. The excerpt intentionally ends at the moment when something seems to emerge.',
    difficultyTags: [
      'classical-compression',
      'daoist-terminology',
      'uncanny-tone',
      'narrative-distance',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 1,
    },
    source: {
      author: '蒲松龄',
      title: '聊斋志异·耳中人',
      year: 1680,
      edition:
        '《聊斋志异》第一卷，维基文库文本；转为简体并删去异文校注',
      url: 'https://zh.wikisource.org/wiki/聊齋志異/第01卷#耳中人',
      excerptBounds:
        '篇首完整叙事单元，自人物介绍至“似有物出”。',
      rightsBasis:
        '蒲松龄及其作品已进入公有领域；维基文库转录文本采用 CC BY-SA 4.0。',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    reviewerChecklist: [
      'Whether “诸生,” “导引,” “趺坐,” and “丹将成” are handled precisely without a glossary-like translation.',
      'Whether the repeated “可以见矣” keeps its ambiguity about who or what may be seen.',
      'Whether “窃喜” remains private, slightly credulous excitement rather than overt comedy.',
      'Whether the final sensory emergence is vivid while leaving the entity unspecified.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-zh-en-ouyangxiu-parties',
    direction: 'zh_to_en',
    category: 'cultural_argument',
    sourceForm: 'classical_chinese_prose',
    genre: 'political memorial and argument',
    era: 'classical',
    canonicality: 'medium',
    sourceText:
      '然臣谓小人无朋，惟君子有之。其故何哉？小人所好者利禄也，所贪者财货也；当其同利之时，暂相党引以为朋者，伪也。及其见利而争先，或利尽而交疏，则反相贼害，虽其兄弟亲戚，不能相保。故臣谓小人无朋，其暂为朋者，伪也。',
    taskBrief:
      'Translate this argument into formal, forceful English prose. Preserve the memorial voice, the deliberately paradoxical claim, the distinction between principled fellowship and temporary collusion for gain, and the causal progression from shared interest to competition and mutual harm. Do not flatten junzi and xiaoren into vague labels; choose a consistent contextual strategy.',
    difficultyTags: [
      'political-concepts',
      'parallel-reasoning',
      'memorial-register',
      'ethical-terminology',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 1,
    },
    source: {
      author: '欧阳修',
      title: '朋党论',
      year: 1044,
      edition: '《欧阳文忠公集》本，维基文库简体页面',
      url: 'https://zh.wikisource.org/zh-hans/朋黨論_(歐陽脩)',
      excerptBounds: '第二段完整论证单元。',
      rightsBasis:
        '欧阳修及其作品已进入公有领域；维基文库转录文本采用 CC BY-SA 4.0。',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    reviewerChecklist: [
      'Whether “朋,” “党引,” and “伪” remain distinct parts of the argument.',
      'Whether junzi and xiaoren receive a consistent and context-sensitive translation.',
      'Whether the transition from common profit to rivalry and mutual injury is logically explicit.',
      'Whether the memorial’s first-person claim and rhetorical question retain formal force.',
    ],
  },
  {
    datasetVersion: 'round2-external-1.0.0',
    split: 'external_holdout',
    id: 'external-zh-en-jiasixie-tillage',
    direction: 'zh_to_en',
    category: 'nonliterary',
    sourceForm: 'classical_chinese_prose',
    genre: 'agricultural technical prose',
    era: 'classical',
    canonicality: 'medium',
    sourceText:
      '凡耕高下田，不问春秋，必须燥湿得所为佳。若水旱不调，宁燥不湿。燥虽耕块，一经得雨，地则粉解；湿耕坚垎，数年不佳。谚曰：“湿耕泽锄，不如归去。”言无益而有损。湿耕者白背速劳之，亦无伤；否则大恶也。春耕寻手劳，秋耕待白背劳。',
    taskBrief:
      'Translate this agricultural instruction into clear, historically responsible English. Preserve the conditional logic about soil moisture, the contrast between dry clods and damage caused by wet ploughing, the proverb, and the sequence of harrowing or levelling after ploughing. Render historical farm terms consistently; where an exact modern implement is uncertain, prefer a cautious functional term over false precision.',
    difficultyTags: [
      'historical-technical-terms',
      'conditional-instructions',
      'agricultural-process',
      'proverb',
    ],
    deterministicConstraints: {
      preserveParagraphs: true,
      expectedParagraphs: 1,
    },
    source: {
      author: '贾思勰',
      title: '齐民要术·耕田第一',
      year: 540,
      edition:
        '《齐民要术》通行本，维基文库四库全书本简体页面；个别异体字按现代简体字整理',
      url: 'https://zh.wikisource.org/zh-hans/齊民要術_(四庫全書本)/全覽',
      excerptBounds: '“凡耕高下田”至“秋耕待白背劳”的完整技术单元。',
      rightsBasis:
        '贾思勰及其作品已进入公有领域；维基文库转录文本采用 CC BY-SA 4.0。',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    reviewerChecklist: [
      'Whether “燥湿得所,” “粉解,” and “坚垎” are rendered as soil conditions rather than moral metaphors.',
      'Whether the recommendation “宁燥不湿” keeps its conditional agricultural rationale.',
      'Whether the proverb remains intelligible and connected to the following explanation.',
      'Whether “劳” and “白背” are translated cautiously and consistently without invented machinery.',
    ],
  },
]

const hash = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

for (const sample of samples) {
  sample.contentHash = hash(sample.sourceText)
}

const ids = new Set(samples.map((sample) => sample.id))
const authors = new Set(samples.map((sample) => sample.source.author))
if (samples.length !== 8 || ids.size !== 8 || authors.size !== 8) {
  throw new Error('External holdout must contain exactly eight unique samples and authors.')
}

const existingSamples = []
for (const fileName of ['quality-dev.jsonl', 'quality-test.jsonl']) {
  const records = (await readFile(
    path.resolve('FSBP_Test', 'datasets', fileName),
    'utf8',
  ))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  existingSamples.push(...records)
}
const existingHashes = new Set(
  existingSamples.map((sample) => sample.contentHash),
)
const existingAuthors = new Set(
  existingSamples.map((sample) => sample.source.author),
)
for (const sample of samples) {
  if (
    existingHashes.has(sample.contentHash) ||
    existingAuthors.has(sample.source.author)
  ) {
    throw new Error(`${sample.id}: duplicates an existing source or author`)
  }
  const size =
    sample.direction === 'en_to_zh'
      ? sample.sourceText.trim().split(/\s+/u).length
      : [...sample.sourceText.replace(/[\s\p{P}\p{S}]/gu, '')].length
  if (
    sample.category !== 'poetry' &&
    sample.direction === 'en_to_zh' &&
    (size < 170 || size > 240)
  ) {
    throw new Error(`${sample.id}: English prose length ${size} is out of range`)
  }
  if (
    sample.category !== 'poetry' &&
    sample.direction === 'zh_to_en' &&
    (size < 80 || size > 140)
  ) {
    throw new Error(`${sample.id}: Classical Chinese length ${size} is out of range`)
  }
}

for (const direction of ['en_to_zh', 'zh_to_en']) {
  const directionSamples = samples.filter(
    (sample) => sample.direction === direction,
  )
  if (directionSamples.length !== 4) {
    throw new Error(`${direction}: expected four samples`)
  }
  for (const category of [
    'poetry',
    'literary',
    'cultural_argument',
    'nonliterary',
  ]) {
    if (
      directionSamples.filter((sample) => sample.category === category)
        .length !== 1
    ) {
      throw new Error(`${direction}/${category}: expected one sample`)
    }
  }
}

await mkdir(outputDir, { recursive: true })
await writeFile(
  outputPath,
  `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`,
  'utf8',
)
await writeFile(
  translatorInputPath,
  `${samples
    .map((sample) =>
      JSON.stringify({
        sampleId: sample.id,
        direction: sample.direction,
        sourceText: sample.sourceText,
        taskBrief: sample.taskBrief,
        deterministicConstraints: sample.deterministicConstraints,
      }),
    )
    .join('\n')}\n`,
  'utf8',
)
await writeFile(
  sourcesPath,
  `${[
    '# Round 2 External Holdout Sources',
    '',
    '本文件包含来源映射，不得交给匿名评审者。八项文本在提示词 v10 与模型分工锁定后建立，不用于继续调参。',
    '',
    ...samples.flatMap((sample) => [
      `## ${sample.id}`,
      '',
      `- 方向：${sample.direction}`,
      `- 类别：${sample.category}`,
      `- 作者：${sample.source.author}`,
      `- 作品：${sample.source.title}`,
      `- 版本：${sample.source.edition}`,
      `- 范围：${sample.source.excerptBounds}`,
      `- 来源：${sample.source.url}`,
      `- 版权依据：${sample.source.rightsBasis}`,
      `- sourceText SHA-256：\`${sample.contentHash}\``,
      '',
    ]),
  ].join('\n')}\n`,
  'utf8',
)

for (const sample of samples) {
  const size =
    sample.direction === 'en_to_zh'
      ? sample.sourceText.trim().split(/\s+/u).length
      : [...sample.sourceText.replace(/[\s\p{P}\p{S}]/gu, '')].length
  process.stdout.write(`${sample.id}\t${size}\t${sample.contentHash}\n`)
}
