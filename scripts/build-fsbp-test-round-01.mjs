import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.cwd(), 'FSBP_Test')
const generatedAt = '2026-07-28T12:00:00+08:00'
const overwriteReview = process.argv.includes('--overwrite-review')

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sample(data) {
  return {
    datasetVersion: '0.1.0',
    split: 'test',
    ...data,
    contentHash: sha256(data.sourceText),
  }
}

const records = [
  {
    sample: sample({
      id: 'test-en-zh-hopkins-pied-beauty',
      direction: 'en_to_zh',
      category: 'poetry',
      sourceForm: 'poetry',
      genre: 'curtal sonnet and devotional lyric',
      era: 'modern',
      canonicality: 'high',
      sourceText: `Glory be to God for dappled things—
For skies of couple-colour as a brinded cow;
For rose-moles all in stipple upon trout that swim:
Fresh-firecoal chestnut-falls; finches' wings;
Landscape plotted and pieced—fold, fallow, and plough;
And áll trádes, their gear and tackle and trim.
All things counter, original, spare, strange;
Whatever is fickle, freckled (who knows how?)
With swift, slow; sweet, sour; adazzle, dim;
He fathers-forth whose beauty is past change:
Praise him.`,
      taskBrief:
        '将全诗译为凝练、可诵读的现代中文诗。保留十一行、列举推进、感官反差、宗教赞颂与原文已有的标点转折。优先传达复杂复合词和声音密度，不为追求押韵增添原文没有的意象。',
      difficultyTags: [
        'coined-compounds',
        'sound-patterning',
        'religious-register',
        'compressed-syntax',
      ],
      deterministicConstraints: {
        preserveLineBreaks: true,
        preserveStanzas: true,
        expectedStanzas: 1,
        expectedNonEmptyLines: 11,
      },
      source: {
        author: 'Gerard Manley Hopkins',
        title: 'Pied Beauty',
        year: 1918,
        edition:
          'Poems of Gerard Manley Hopkins, edited by Robert Bridges, 1918; English Wikisource transcription, revision 6593179',
        url: 'https://en.wikisource.org/w/index.php?title=Poems_of_Gerard_Manley_Hopkins/Pied_Beauty&oldid=6593179',
        excerptBounds: 'Complete poem, all 11 lines.',
        rightsBasis:
          'The poem and 1918 edition are in the public domain; the cited Wikisource transcription is available under CC BY-SA 4.0.',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否处理 dappled、couple-colour、brinded、rose-moles 与 stipple 的连续斑驳意象',
        '是否保留 swift/slow、sweet/sour、adazzle/dim 的对举节奏',
        '是否理解 fathers-forth 的造词及末尾宗教语气',
        '是否在中文中保住压缩和声音密度而没有变成解释性散文',
      ],
    }),
    translation: `荣耀归于上帝，因万物斑驳—
因天空双色，像花斑的母牛；
因游鳟身上点点玫瑰斑痣：
鲜亮的炭火，栗子落下；雀鸟的翼；
土地划分又拼合—畜栏、休耕地与犁田；
各门手艺，以及它们的器具、装备与装束。
万物相反、独特、稀疏、奇异；
一切变幻而带斑点的事物（谁知其由？）
迅疾、迟缓；甜美、酸涩；耀眼、昏暗；
他使它们生发，而他的美永不改变：
赞美他。`,
    preflight: [
      '“Fresh-firecoal chestnut-falls”句法极度压缩；“栗子落下”可能遗漏剥开栗壳时如炭火发亮的综合色彩。',
      '“fold”在田野语境可指羊栏或圈地；译为“畜栏”仍需核验与 landscape 列举的层级。',
      '“áll trádes”及“gear and tackle and trim”兼有行业、器具和外观的声音堆叠，直译可能显得说明化。',
      '“fathers-forth”译为“使它们生发”传达了创造，却弱化了 father 作为父与造物主的双重语感。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-hardy-neutral-tones',
      direction: 'en_to_zh',
      category: 'poetry',
      sourceForm: 'poetry',
      genre: 'lyric poem',
      era: 'modern',
      canonicality: 'medium',
      sourceText: `We stood by a pond that winter day,
And the sun was white, as though chidden of God,
And a few leaves lay on the starving sod,
  —They had fallen from an ash, and were gray.

Your eyes on me were as eyes that rove
Over tedious riddles solved years ago;
And some words played between us to and fro—
  On which lost the more by our love.
The smile on your mouth was the deadest thing
Alive enough to have strength to die;
And a grin of bitterness swept thereby
  Like an ominous bird a-wing . . .

Since then, keen lessons that love deceives,
And wrings with wrong, have shaped to me
Your face, and the God-curst sun, and a tree,
  And a pond edged with grayish leaves.`,
      taskBrief:
        '将全诗译为克制、冷峻的现代中文诗。保留四节、十六行、灰白色调、句法悬置与末节回望结构；原文中的破折号可以保留，不在其他位置另加破折号或分号。',
      difficultyTags: [
        'negative-imagery',
        'syntactic-suspension',
        'personification',
        'retrospective-voice',
      ],
      deterministicConstraints: {
        preserveLineBreaks: true,
        preserveStanzas: true,
        expectedStanzas: 4,
        expectedNonEmptyLines: 16,
      },
      source: {
        author: 'Thomas Hardy',
        title: 'Neutral Tones',
        year: 1898,
        edition:
          'Wessex Poems and Other Verses, Project Gutenberg eBook #3167, HTML edition',
        url: 'https://www.gutenberg.org/files/3167/3167-h/3167-h.htm',
        excerptBounds: 'Complete poem, all four stanzas and 16 lines.',
        rightsBasis:
          'The poem is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
        licenseUrl: 'https://www.gutenberg.org/policy/license.html',
      },
      reviewerChecklist: [
        '是否维持白日、饥饿草地、灰叶等统一的枯竭色调',
        '是否准确处理 tedious riddles solved years ago 的冷漠凝视',
        '是否读清 On which lost the more by our love 的省略关系',
        '是否让末节 shaped to me 的回忆定型与前文意象相扣',
      ],
    }),
    translation: `那个冬日，我们站在池边，
太阳惨白，仿佛受过上帝斥责，
几片叶子躺在饥饿的草皮上，
  —它们从一株白蜡树落下，灰蒙蒙。

你看我的眼神像目光游移，
掠过多年前已解开的乏味谜题；
几句话在我们之间来回游荡—
  争论谁因我们的爱失去更多。
你唇上的微笑是最死寂的东西，
却还活到有力气死去；
一抹苦涩的狞笑从旁掠过，
  像一只展翼的不祥之鸟……

从那以后，爱情欺人的惨痛教训，
以及它以错误施加的折磨，为我塑成
你的脸、被上帝诅咒的太阳、一棵树，
  还有一方镶着灰叶的池塘。`,
    preflight: [
      '“chidden of God”既可理解为受上帝斥责，也可能是被上帝的斥责吓白，直译没有消除歧义。',
      '“On which lost the more by our love”结构异常，“争论”是译文补出的关系，可能过度确定。',
      '“the deadest thing / Alive enough to have strength to die”依靠悖论，中文“有力气死去”较口语，诗性与准确性可能冲突。',
      '“wrings with wrong”同时包含扭绞、痛苦与不公，译成“以错误施加的折磨”可能未保住声音和动作。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-jerome-sea-trip',
      direction: 'en_to_zh',
      category: 'literary',
      sourceForm: 'english_prose',
      genre: 'comic first-person travel narrative',
      era: 'modern',
      canonicality: 'medium',
      sourceText: `I objected to the sea trip strongly. A sea trip does you good when you are going to have a couple of months of it, but, for a week, it is wicked.

You start on Monday with the idea implanted in your bosom that you are going to enjoy yourself. You wave an airy adieu to the boys on shore, light your biggest pipe, and swagger about the deck as if you were Captain Cook, Sir Francis Drake, and Christopher Columbus all rolled into one. On Tuesday, you wish you hadn’t come. On Wednesday, Thursday, and Friday, you wish you were dead. On Saturday, you are able to swallow a little beef tea, and to sit up on deck, and answer with a wan, sweet smile when kind-hearted people ask you how you feel now. On Sunday, you begin to walk about again, and take solid food. And on Monday morning, as, with your bag and umbrella in your hand, you stand by the gunwale, waiting to step ashore, you begin to thoroughly like it.

I remember my brother-in-law going for a short sea trip once, for the benefit of his health. He took a return berth from London to Liverpool; and when he got to Liverpool, the only thing he was anxious about was to sell that return ticket.`,
      contextBefore:
        'The narrator and his friends are debating whether a short sea voyage would provide the rest and change they believe they need.',
      taskBrief:
        '译为自然、轻快而有节奏的现代中文幽默叙事。保留三段、星期推进、夸张语气、航海人物典故和叙述者一本正经的口吻，不把笑点改写成解释。',
      difficultyTags: [
        'comic-voice',
        'temporal-compression',
        'cultural-allusions',
        'ironic-understatement',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 3,
        preserveChronology: true,
      },
      source: {
        author: 'Jerome K. Jerome',
        title: 'Three Men in a Boat (To Say Nothing of the Dog)',
        year: 1889,
        edition:
          'J. W. Arrowsmith first edition (1889), Project Gutenberg eBook #308, HTML transcription updated 2022',
        url: 'https://www.gutenberg.org/files/308/308-h/308-h.htm',
        excerptBounds:
          'Chapter I, three complete paragraphs beginning “I objected to the sea trip strongly” and ending “sell that return ticket.”',
        rightsBasis:
          'The 1889 work is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
        licenseUrl: 'https://www.gutenberg.org/policy/license.html',
      },
      reviewerChecklist: [
        '是否保持叙述者郑重其事地夸张晕船痛苦的反差，而没有把幽默译成单纯抱怨',
        '是否保留从星期一到下一个星期一的节奏和笑点落点',
        '是否让三位航海人物的叠加典故自然可懂，又不额外解释',
        '是否准确处理 beef tea、gunwale、return berth 等时代与航海表达',
      ],
    }),
    translation: `我强烈反对出海旅行。要是在海上待上两个月，坐船的确对人有好处，但若只有一周，那简直是在作孽。

星期一出发时，你满心认定自己一定会玩得痛快。你潇洒地向岸上的伙伴挥手告别，点起最大号的烟斗，在甲板上昂首阔步，仿佛库克船长、弗朗西斯·德雷克爵士和克里斯托弗·哥伦布合为一体。到了星期二，你开始后悔上船。星期三、星期四和星期五，你恨不得一死了之。星期六，你总算能咽下几口牛肉清汤，也能坐到甲板上。好心人问你现在感觉如何，你便报以一个苍白而甜美的微笑。星期日，你开始重新走动，也能吃些实在的食物。等到下一个星期一早晨，你一手提包、一手拿伞，站在船舷边等着上岸时，才终于开始真正喜欢上这趟航行。

我记得我姐夫有一回为了健康，去作了一次短途海上旅行。他买的是伦敦到利物浦的往返船位。可到了利物浦，他唯一急着做的事，就是把返程票卖掉。`,
    preflight: [
      '“wicked”是故作严厉的夸张，译成“作孽”加强了中文笑感，也可能比原文更口语。',
      '“the boys on shore”并非特指少年，译成“岸上的伙伴”避免了年龄误读。',
      '三位航海人物在中文读者中的熟悉度不同，保留姓名维护笑点结构，但典故效果可能减弱。',
      '“beef tea”是清澈的牛肉汤或肉汁饮品，“牛肉清汤”便于理解，但时代质感可能不足。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-wells-door-memory',
      direction: 'en_to_zh',
      category: 'literary',
      sourceForm: 'english_prose',
      genre: 'psychological frame narrative',
      era: 'modern',
      canonicality: 'medium',
      sourceText: `One confidential evening, not three months ago, Lionel Wallace told me this story of the Door in the Wall. And at the time I thought that so far as he was concerned it was a true story.

He told it me with such a direct simplicity of conviction that I could not do otherwise than believe in him.

But in the morning, in my own flat, I woke to a different atmosphere, and as I lay in bed and recalled the things he had told me, stripped of the glamour of his earnest slow voice, denuded of the focussed shaded table light, the shadowy atmosphere that wrapped about him and the pleasant bright things, the dessert and glasses and napery of the dinner we had shared, making them for the time a bright little world quite cut off from every-day realities, I saw it all as frankly incredible.

“He was mystifying!” I said, and then: “How well he did it!. . . . . It isn’t quite the thing I should have expected him, of all people, to do well.”

Afterwards, as I sat up in bed and sipped my morning tea, I found myself trying to account for the flavour of reality that perplexed me in his impossible reminiscences, by supposing they did in some way suggest, present, convey—I hardly know which word to use—experiences it was otherwise impossible to tell.`,
      taskBrief:
        '译为自然、克制而带悬念的现代中文心理叙事。保留五段、夜晚与清晨的认知反转、长句中的感官层次，以及叙述者在相信与怀疑之间的摇摆，不替读者判定回忆的真假。',
      difficultyTags: [
        'frame-narration',
        'psychological-ambiguity',
        'long-syntax',
        'atmospheric-prose',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 5,
        preserveQuotations: true,
      },
      source: {
        author: 'H. G. Wells',
        title: 'The Door in the Wall',
        year: 1911,
        edition:
          'The Door in the Wall, and Other Stories (1911), Project Gutenberg eBook #456, HTML transcription updated 2021',
        url: 'https://www.gutenberg.org/files/456/456-h/456-h.htm',
        excerptBounds:
          'Section I, first five complete paragraphs beginning “One confidential evening” and ending “experiences it was otherwise impossible to tell.”',
        rightsBasis:
          'The 1911 collection is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
        licenseUrl: 'https://www.gutenberg.org/policy/license.html',
      },
      reviewerChecklist: [
        '是否保持夜晚相信、清晨怀疑的视角转折，而没有提前裁定故事真假',
        '是否在中文中理清长句里声音、灯光、阴影、餐桌物件与现实隔绝感的层层剥离',
        '是否让 mystifying 同时保留困惑和疑似故弄玄虚的意味',
        '是否准确处理 flavour of reality 与 suggest、present、convey 的自我修正',
      ],
    }),
    translation: `不到三个月前的一个夜晚，在一次推心置腹的谈话中，莱昂内尔·华莱士向我讲起了墙中之门的故事。那时我认为，至少对他本人而言，这是一件真事。

他讲述时，信念坦率而质朴，使我无法不相信他。

然而第二天清晨，我在自己的公寓里醒来，周遭气氛已经不同。我躺在床上回想他讲过的一切，剥去他认真而缓慢的声音所带来的魅力，撤去聚拢在有灯罩的餐桌灯下的光，撇开笼罩着他的幽暗气氛，也撇开我们共进晚餐时那些明亮悦目的东西，甜点、酒杯和桌布。它们当时构成了一个明亮的小世界，仿佛与日常现实彻底隔绝。失去这一切之后，整个故事在我看来简直难以置信。

“他是在故弄玄虚！”我说，随后又想，“可他装得真像！在所有人里，我最想不到他竟会擅长这种事。”

后来，我坐起身来，啜饮早茶。我发现自己仍在设法解释，那些不可能的回忆为何带着一种令我困惑的真实感。我猜想，它们也许以某种方式暗示、呈现或传达了某些经验，我甚至不知道该用哪个词，而那些经验原本无法诉说。`,
    preflight: [
      '“One confidential evening”不是普通时间状语，“一次推心置腹的谈话中”补明了关系，也牺牲了原文的陌生搭配。',
      '第三段原文以一个极长句完成气氛剥离，中文拆句提升可读性，但可能削弱清晨怀疑逐步压倒夜晚魅力的连续感。',
      '“He was mystifying”既可能指他令人困惑，也可能指他有意迷惑人；“故弄玄虚”选择了后者。',
      '“flavour of reality”译成“真实感”自然但损失味觉隐喻，末句的 suggest、present、convey 也难在中文中保持同等迟疑。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-douglass-literacy',
      direction: 'en_to_zh',
      category: 'cultural_argument',
      sourceForm: 'english_prose',
      genre: 'autobiographical abolitionist argument',
      era: 'modern',
      canonicality: 'medium',
      sourceText: `These words sank deep into my heart, stirred up sentiments within that lay slumbering, and called into existence an entirely new train of thought. It was a new and special revelation, explaining dark and mysterious things, with which my youthful understanding had struggled, but struggled in vain. I now understood what had been to me a most perplexing difficulty—to wit, the white man’s power to enslave the black man.

It was a grand achievement, and I prized it highly. From that moment, I understood the pathway from slavery to freedom. It was just what I wanted, and I got it at a time when I the least expected it. Whilst I was saddened by the thought of losing the aid of my kind mistress, I was gladdened by the invaluable instruction which, by the merest accident, I had gained from my master.

Though conscious of the difficulty of learning without a teacher, I set out with high hope, and a fixed purpose, at whatever cost of trouble, to learn how to read. The very decided manner with which he spoke, and strove to impress his wife with the evil consequences of giving me instruction, served to convince me that he was deeply sensible of the truths he was uttering.`,
      contextBefore:
        'Douglass has overheard Hugh Auld insist that teaching an enslaved person to read would make him unfit for slavery.',
      taskBrief:
        '译为清晰、有力量的现代中文自传论述。保留三段、认知转折、奴隶主的反对如何反向揭示自由道路，以及时代语境中的称谓；不淡化奴隶制，也不替作者加入当代评论。',
      difficultyTags: [
        'historical-racial-register',
        'ironic-reversal',
        'autobiographical-voice',
        'causal-argument',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 3,
        preserveCausalReversal: true,
      },
      source: {
        author: 'Frederick Douglass',
        title: 'Narrative of the Life of Frederick Douglass, an American Slave',
        year: 1845,
        edition:
          'Project Gutenberg eBook #23, 1845 Boston edition transcription',
        url: 'https://www.gutenberg.org/cache/epub/23/pg23-images.html',
        excerptBounds:
          'Chapter VI, three complete paragraphs beginning “These words sank deep” and ending “truths he was uttering.”',
        rightsBasis:
          'The 1845 work is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
        licenseUrl: 'https://www.gutenberg.org/policy/license.html',
      },
      reviewerChecklist: [
        '是否让 revelation 从个人顿悟推进到奴役机制的认识',
        '是否准确处理 mistress/master 在奴隶制语境中的身份而避免现代普通称谓误解',
        '是否呈现奴隶主斩钉截铁的警告如何反向证实识字的力量',
        '是否保留从困惑、启示、道路到行动决心的认知推进',
      ],
    }),
    translation: `这些话深深沉入我的心中，唤醒了沉睡在内心的感受，又引出一条全新的思路。它像一场崭新而特别的启示，解释了我年幼的理解力曾苦苦思索，却始终无法看透的幽暗谜团。我终于明白了那个最令我困惑的问题，也就是白人奴役黑人的力量从何而来。

这是一次重大的思想收获，我极其珍视。从那一刻起，我明白了从奴役通向自由的道路。这正是我想要的东西，却在最意想不到的时候得到了它。一想到将失去善良女主人的帮助，我固然难过，但男主人偶然给我的这番无价教诲，又使我欣喜。

我知道无人教导，学习必定困难，但仍满怀希望，意志坚定地出发，不惜任何辛苦也要学会阅读。他说话时语气斩钉截铁，又竭力让妻子相信教我识字会造成恶果，这反而使我确信，他深知自己所说的确是真话。`,
    preflight: [
      '“revelation”兼有宗教启示色彩，“一场启示”自然但可能弱化其圣经式语域。',
      '“the white man’s power to enslave the black man”译文补出“从何而来”，逻辑吻合，但原文名词性判断更直接。',
      'mistress/master 译为“女主人/男主人”能标示制度关系，却可能遮蔽二者同时是夫妻的照应。',
      '“at whatever cost of trouble”译为“不惜任何辛苦”略显口号化，需核验自传声音是否过度拔高。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-mill-opposing-truths',
      direction: 'en_to_zh',
      category: 'cultural_argument',
      sourceForm: 'english_prose',
      genre: 'political philosophy',
      era: 'modern',
      canonicality: 'high',
      sourceText: `Unless opinions favourable to democracy and to aristocracy, to property and to equality, to co-operation and to competition, to luxury and to abstinence, to sociality and individuality, to liberty and discipline, and all the other standing antagonisms of practical life, are expressed with equal freedom, and enforced and defended with equal talent and energy, there is no chance of both elements obtaining their due; one scale is sure to go up, and the other down.

Truth, in the great practical concerns of life, is so much a question of the reconciling and combining of opposites, that very few have minds sufficiently capacious and impartial to make the adjustment with an approach to correctness, and it has to be made by the rough process of a struggle between combatants fighting under hostile banners.

On any of the great open questions just enumerated, if either of the two opinions has a better claim than the other, not merely to be tolerated, but to be encouraged and countenanced, it is the one which happens at the particular time and place to be in a minority. That is the opinion which, for the time being, represents the neglected interests, the side of human well-being which is in danger of obtaining less than its share.`,
      taskBrief:
        '译为严谨、流畅的现代中文哲学论述。保留三段、成组对举、天平与战斗比喻，以及“容忍—鼓励—代表被忽略利益”的论证递进；不将历史自由主义术语替换为当代政治口号。',
      difficultyTags: [
        'philosophical-argument',
        'paired-antitheses',
        'historical-political-terms',
        'metaphor',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 3,
        preservePairedTerms: true,
      },
      source: {
        author: 'John Stuart Mill',
        title: 'On Liberty',
        year: 1869,
        edition:
          'Fourth edition, London: Longmans, Green, Reader and Dyer, 1869; English Wikisource transcription',
        url: 'https://en.wikisource.org/wiki/On_Liberty/Chapter_2',
        excerptBounds:
          'Chapter II, three complete paragraphs beginning “Unless opinions favourable” and ending “less than its share.”',
        rightsBasis:
          'The 1869 edition is in the public domain; the cited Wikisource transcription is available under CC BY-SA 4.0.',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否保持六组社会政治概念的成对结构而不混同层级',
        '是否准确处理 obtaining their due 与 less than its share 的份额隐喻',
        '是否保留容忍少数意见与积极鼓励少数意见之间的论证升级',
        '是否让天平比喻与敌对旗帜下战斗的粗粝过程彼此衔接',
      ],
    }),
    translation: `支持民主与贵族制、财产权与平等、合作与竞争、奢侈与节制、社会性与个体性、自由与纪律的意见，以及现实生活中其他一切长期对立的意见，必须得到同等自由的表达，并由同等的才智和力量加以申说与辩护。否则，两种因素便不可能各得其所；天平的一端必然上升，另一端必然下降。

在生活中重大的实际事务上，真理在很大程度上取决于对立面的调和与结合。然而，极少有人拥有足够宽广而公正的心智，能把这种调整做得近乎正确。因此，这种调整只能通过一场粗粝的过程完成，也就是敌对旗帜下的战士彼此斗争。

在刚才列举的任何重大开放问题上，如果两种意见中有一种比另一种更有资格不仅得到容忍，而且得到鼓励和支持，那么它就是在特定时间和地点恰好处于少数的那一种。因为在当时，它所代表的是被忽略的利益，是人类福祉中可能得不到应有份额的那一面。`,
    preflight: [
      '选段以 Unless 条件句直接开篇，虽是完整段落，但六组对举所回应的前文理论背景未被收入正文。',
      'property 译为“财产权”比“财产”更像政治概念，但原文与 equality 的对举未必专指权利法理。',
      '“enforced”在论证语境指有力阐明，译成“申说”较克制，却可能不足以表现力度。',
      '“rough process”译为“粗粝的过程”略生硬；若改成“粗暴过程”又会加入负面判断。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-lovelace-engine-limits',
      direction: 'en_to_zh',
      category: 'nonliterary',
      sourceForm: 'english_prose',
      genre: 'computing and mathematical commentary',
      era: 'modern',
      canonicality: 'high',
      sourceText: `It is desirable to guard against the possibility of exaggerated ideas that might arise as to the powers of the Analytical Engine. In considering any new subject, there is frequently a tendency, first, to overrate what we find to be already interesting or remarkable; and, secondly, by a sort of natural reaction, to undervalue the true state of the case, when we do discover that our notions have surpassed those that were really tenable.

The Analytical Engine has no pretensions whatever to originate anything. It can do whatever we know how to order it to perform. It can follow analysis; but it has no power of anticipating any analytical relations or truths. Its province is to assist us in making available what we are already acquainted with. This it is calculated to effect primarily and chiefly of course, through its executive faculties; but it is likely to exert an indirect and reciprocal influence on science itself in another manner.

For, in so distributing and combining the truths and the formulæ of analysis, that they may become most easily and rapidly amenable to the mechanical combinations of the engine, the relations and the nature of many subjects in that science are necessarily thrown into new lights, and more profoundly investigated.`,
      contextBefore:
        'This passage appears in Ada Lovelace’s Note G to her translation and commentary on Menabrea’s account of Babbage’s Analytical Engine.',
      taskBrief:
        '译为准确、可读的现代中文科技思想文本。保留四段、能力边界、执行能力与科学反作用之间的区分，以及十九世纪术语语感；不得把 Analytical Engine 直接改写成现代人工智能。',
      difficultyTags: [
        'historical-computing',
        'epistemic-modality',
        'technical-metaphor',
        'long-syntax',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 3,
        requiredTerms: ['分析机'],
      },
      source: {
        author: 'Ada Augusta, Countess of Lovelace',
        title:
          'Notes to Sketch of the Analytical Engine Invented by Charles Babbage, Note G',
        year: 1843,
        edition:
          'Richard and John E. Taylor, Scientific Memoirs, Vol. III (1843); Fourmilab HTML transcription',
        url: 'https://www.fourmilab.ch/babbage/sketch.html',
        excerptBounds:
          'Note G, three complete paragraphs beginning “It is desirable to guard” and ending “more profoundly investigated.”',
        rightsBasis:
          'The 1843 work is in the public domain; the cited page transcribes the historical publication.',
      },
      reviewerChecklist: [
        '是否区分 originate、order、follow analysis 与 anticipate relations or truths',
        '是否准确处理 executive faculties，而未套用现代 CPU 或 AI 术语',
        '是否译清机械化重组公式如何反过来照亮理论关系',
        '是否保持可能性和推测程度，不把 likely、calculated to 等写成确定结论',
      ],
    }),
    translation: `我们应当防止人们对分析机的能力产生夸大的观念。面对任何新事物，人们往往先会高估其中已经显得有趣或非凡的部分；待到发现自己的想法超出了真正站得住脚的范围，又会出于某种自然的反作用，低估事情的真实状况。

分析机绝无自行创生任何事物的主张。凡是我们知道如何命令它完成的事情，它都能完成。它能够遵循分析，却无力预见任何分析关系或真理。它的职责，是帮助我们把已经掌握的知识转化为可用之物。当然，它主要凭借执行能力达到这一目的；但它也可能以另一种方式，对科学本身产生间接而相互的影响。

为了让分析的真理和公式最容易、最快速地接受机器的机械组合，我们必须对它们加以分配和组合。这样一来，这门科学中许多对象的关系与本质，必然会在新的光照下显现，并得到更深入的研究。`,
    preflight: [
      '“originate anything”译为“自行创生”偏哲学化，但可避免误读成“不能输出任何新组合”。',
      '“follow analysis”中的 analysis 是十九世纪数学分析，译文若只写“分析”可能被现代读者理解成一般推理。',
      '“amenable to mechanical combinations”译成“接受机器的机械组合”略显重复，却保留了 engine 与 mechanical 的关系。',
      '第三段的被动长句由“分配和组合”推进到“新的光照”和“深入研究”，中文改成主动关系后可能改变论证重心。',
    ],
  },
  {
    sample: sample({
      id: 'test-en-zh-darwin-selection',
      direction: 'en_to_zh',
      category: 'nonliterary',
      sourceForm: 'english_prose',
      genre: 'scientific argument',
      era: 'modern',
      canonicality: 'medium',
      sourceText: `Can it, then, be thought improbable, seeing that variations useful to man have undoubtedly occurred, that other variations useful in some way to each being in the great and complex battle of life, should sometimes occur in the course of thousands of generations? If such do occur, can we doubt (remembering that many more individuals are born than can possibly survive) that individuals having any advantage, however slight, over others, would have the best chance of surviving and of procreating their kind? On the other hand, we may feel sure that any variation in the least degree injurious would be rigidly destroyed.

This preservation of favourable variations and the rejection of injurious variations, I call Natural Selection. Variations neither useful nor injurious would not be affected by natural selection, and would be left a fluctuating element, as perhaps we see in the species called polymorphic.

We shall best understand the probable course of natural selection by taking the case of a country undergoing some physical change, for instance, of climate. The proportional numbers of its inhabitants would almost immediately undergo a change, and some species might become extinct.`,
      taskBrief:
        '译为严谨、清晰的现代中文科学论述。保留四段、设问、概率与推论措辞、术语定义及种群比例的因果链；沿用“自然选择”等通行术语，但不把十九世纪表述擅自改成现代教科书结论。',
      difficultyTags: [
        'scientific-causality',
        'historical-terminology',
        'epistemic-modality',
        'nested-questions',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 3,
        requiredTerms: ['自然选择'],
      },
      source: {
        author: 'Charles Darwin',
        title: 'On the Origin of Species',
        year: 1860,
        edition:
          'Second edition (1860), Project Gutenberg eBook #22764, illustrated HTML transcription',
        url: 'https://www.gutenberg.org/cache/epub/22764/pg22764-images.html',
        excerptBounds:
          'Chapter IV, three complete paragraphs beginning “Can it, then, be thought improbable” and ending “some species might become extinct.”',
        rightsBasis:
          'The 1860 work is in the public domain; the Project Gutenberg transcription is reusable under the Project Gutenberg License.',
        licenseUrl: 'https://www.gutenberg.org/policy/license.html',
      },
      reviewerChecklist: [
        '是否保留 improbable、sometimes、best chance、may 等概率与认识限定',
        '是否准确区分 favourable、injurious 与 neither useful nor injurious 三类变异',
        '是否让自然选择定义与后续环境变化例证衔接',
        '是否把 proportional numbers 与物种间相互关系译成种群比例，而非个体绝对数量',
      ],
    }),
    translation: `既然对人类有用的变异无疑曾经出现，那么，在成千上万代的过程中，偶尔出现以某种方式有利于每种生物，使其能应对伟大而复杂的生存斗争的其他变异，难道可以认为是不大可能的吗？如果这类变异确实出现，我们又怎能怀疑，那些比其他个体拥有任何优势的个体，无论优势多么微小，都会获得最大的生存与繁殖机会？须记住，出生的个体远多于可能存活的个体。反过来，我们可以确信，任何哪怕略有危害的变异都会受到严格淘汰。

我把有利变异的保存和有害变异的排除称为自然选择。既无利也无害的变异不会受到自然选择影响，而会作为一种波动因素保留下来，我们在所谓多型物种中看到的也许正是这种情形。

要理解自然选择可能经历的过程，最好考察一个正在发生某种自然条件变化的地区，例如气候变化。当地各种生物在数量上的比例几乎会立刻改变，有些物种还可能灭绝。`,
    preflight: [
      '“great and complex battle of life”译为“生存斗争”借用了后来的通行术语，可能压平 battle 的修辞力度。',
      '“rigidly destroyed”直译接近“严酷地毁灭”，译为“严格淘汰”更科学化，也更像后世教科书。',
      '“country”在自然史语境是地理区域，不一定是现代国家；译文用“地区”属于解释性规范化。',
      '“proportional numbers of its inhabitants”译成“各种生物在数量上的比例”较自然，但 inhabitants 在这里指地区内所有生物。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-sushi-shuidiaogetou',
      direction: 'zh_to_en',
      category: 'poetry',
      sourceForm: 'poetry',
      genre: 'ci lyric',
      era: 'medieval',
      canonicality: 'high',
      sourceText: `丙辰中秋，欢饮达旦，大醉，作此篇，兼怀子由。

明月几时有？把酒问青天。
不知天上宫阙，今夕是何年。
我欲乘风归去，又恐琼楼玉宇，高处不胜寒。
起舞弄清影，何似在人间！

转朱阁，低绮户，照无眠。
不应有恨，何事长向别时圆！
人有悲欢离合，月有阴晴圆缺，此事古难全。
但愿人长久，千里共婵娟。`,
      taskBrief:
        'Translate the complete preface and ci lyric into literary but intelligible English verse. Preserve the two lyric sections, the motion from questioning Heaven to thinking of separation, the moon imagery, and sentence continuity across source lines. Do not force end-stops where the Chinese syntax continues.',
      difficultyTags: [
        'ci-form',
        'mythic-imagery',
        'syntactic-continuity',
        'cultural-allusion',
      ],
      deterministicConstraints: {
        preserveLineBreaks: true,
        preserveStanzas: true,
        expectedStanzas: 3,
        expectedNonEmptyLines: 9,
      },
      source: {
        author: '苏轼',
        title: '水调歌头（明月几时有）',
        year: 1076,
        edition:
          '据《白香词谱笺》所录正文；中文维基文库 revision 5183215，转为简体字',
        url: 'https://zh.wikisource.org/w/index.php?title=%E6%B0%B4%E8%AA%BF%E6%AD%8C%E9%A0%AD_(%E6%98%8E%E6%9C%88%E5%B9%BE%E6%99%82%E6%9C%89)&oldid=5183215',
        excerptBounds:
          '完整小序及全词；采用横排正文主读，不收入脚注异文。',
        rightsBasis:
          '北宋作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否处理 归去、琼楼玉宇、不胜寒、弄清影 与 婵娟 的文化语义',
        '是否保持问天、欲归、恐寒、人间起舞的心理转折',
        '是否避免把“转朱阁，低绮户，照无眠”误判为互不相干的句子',
        '是否让结尾祝愿保持含蓄而不额外解释兄弟关系',
      ],
    }),
    translation: `On the Mid-Autumn night of the bingchen year, I drank merrily until dawn. Deeply drunk, I wrote this, thinking also of Ziyou.

When did the bright moon first appear? Cup in hand, I ask the blue vault.
I do not know what year tonight may be in the celestial palaces.
I long to ride the wind and return, yet fear those towers of jade and crystal, where the heights are too cold to bear.
I rise and dance with my clear shadow. How could that compare with being here among humankind?

It wheels past the vermilion tower, bends low at the patterned window, and shines upon the sleepless.
Surely it bears no grudge, so why is it always full when people part?
People know joy and sorrow, meeting and separation; the moon knows brightness and shadow, fullness and want. Such things have never been perfect.
May we both live long, sharing this fair moon though a thousand miles apart.`,
    preflight: [
      '“归去”带有返回天上故乡的道家想象，译成 return 保留方向，却未说明为什么是“归”。',
      '“何似在人间”存在比较方向争议，译成反问“怎比得在人间”采取了人间更好的读法。',
      '“转、低、照”是月光连续移动；译文用 wheels/bends/shines 强化了月亮作为动作主体。',
      '“婵娟”译为 fair moon 取代美好月色或月中嫦娥的复合联想，结句另补 both 明示两人。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-wentingyun-pusaman',
      direction: 'zh_to_en',
      category: 'poetry',
      sourceForm: 'poetry',
      genre: 'ci lyric',
      era: 'medieval',
      canonicality: 'medium',
      sourceText: `小山重叠金明灭，
鬓云欲度香腮雪。
懒起画蛾眉，
弄妆梳洗迟。

照花前后镜，
花面交相映。
新贴绣罗襦，
双双金鹧鸪。`,
      taskBrief:
        'Translate the complete ci lyric into sensuous but controlled English verse. Preserve two sections, eight lines, the sequence of waking, grooming, mirroring, dressing, and the final paired-partridge image. Keep ambiguity where the Chinese image does not identify a single object.',
      difficultyTags: [
        'dense-imagery',
        'ambiguous-reference',
        'grooming-culture',
        'visual-symmetry',
      ],
      deterministicConstraints: {
        preserveLineBreaks: true,
        preserveStanzas: true,
        expectedStanzas: 2,
        expectedNonEmptyLines: 8,
      },
      source: {
        author: '温庭筠',
        title: '菩萨蛮（小山重叠金明灭）',
        edition:
          '《全唐五代词》所录正文；中文维基文库 revision 2644541，转为简体字',
        url: 'https://zh.wikisource.org/w/index.php?title=%E8%8F%A9%E8%96%A9%E8%A0%BB_(%E5%B0%8F%E5%B1%B1%E9%87%8D%E7%96%8A%E9%87%91%E6%98%8E%E6%BB%85)&oldid=2644541',
        excerptBounds: '完整全词八行；不收入“贴/帖”异文说明。',
        rightsBasis:
          '唐代作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否保留 小山、金、鬓云、香腮雪 的物象重叠而不武断解释',
        '是否准确处理 画蛾眉、弄妆、前后镜 与 罗襦 等妆饰语汇',
        '是否让照镜时花与人脸交映的空间关系成立',
        '是否识别末尾成双鹧鸪与人物孤单之间的含蓄张力',
      ],
    }),
    translation: `Little hills overlap as gold glimmers and goes dim;
clouds of hair would drift across cheeks fragrant as snow.
Too languid to rise, she paints her moth-wing brows,
playing with her dress, she washes and combs her hair slowly.

Front and rear mirrors reflect the flower in her hair;
flower and face shine back upon each other.
On her newly fastened embroidered silk jacket
golden partridges appear in pairs.`,
    preflight: [
      '“小山”究竟指屏风、发髻、眉形或妆饰，历来有争议；译成 little hills 刻意不裁决，但英语读者可能无法形成妆容语境。',
      '“鬓云欲度香腮雪”译文加入 would drift，保留动态，却把“雪”明确变成脸颊比喻。',
      '“弄妆”不等于 playing with her dress，可能是摆弄妆饰或梳妆，当前译法语义偏移。',
      '“照花前后镜”如何使用前后两镜及“花”指人、妆花还是钗花均有歧义，译文选择了 hair flower。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-zhangdai-west-lake-snow',
      direction: 'zh_to_en',
      category: 'literary',
      sourceForm: 'classical_chinese_prose',
      genre: 'travel sketch',
      era: 'early_modern',
      canonicality: 'high',
      sourceText:
        '崇祯五年十二月，余住西湖。大雪三日，湖中人鸟声俱绝。\n\n是日更定矣，余拿一小舟，拥毳衣炉火，独往湖心亭看雪。雾凇沆砀，天与云、与山、与水，上下一白。湖上影子，惟长堤一痕，湖心亭一点，与余舟一芥，舟中人两三粒而已。',
      taskBrief:
        'Translate this complete scenic unit into spare, vivid literary English. Preserve two paragraphs, the time sequence, silence, scale reduction, and the progression from sky and water to trace, dot, mustard seed, and grains. Do not add emotional explanation.',
      difficultyTags: [
        'classical-compression',
        'scale-imagery',
        'historical-timekeeping',
        'visual-minimalism',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 2,
      },
      source: {
        author: '张岱',
        title: '湖心亭看雪',
        year: 1633,
        edition:
          '《陶庵梦忆》卷三所收；中文维基文库正文，检索于 2026-07-28，转为简体字',
        url: 'https://zh.wikisource.org/zh-hans/%E6%B9%96%E5%BF%83%E4%BA%AD%E7%9C%8B%E9%9B%AA',
        excerptBounds:
          '开头两个完整段落，从“崇祯五年十二月”至“舟中人两三粒而已”。',
        rightsBasis:
          '明末清初作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否准确处理 更定、拿、毳衣、雾凇沆砀 等历史和景物词',
        '是否保留“大雪三日”后人声鸟声俱绝的听觉空白',
        '是否让天、云、山、水“上下一白”形成整体空间',
        '是否保持 痕、点、芥、粒 逐级缩小而不解释人物心情',
      ],
    }),
    translation: `In the twelfth month of the fifth Chongzhen year, I was staying by West Lake. Snow fell heavily for three days. On the lake, every sound of human and bird had ceased.

That day, after the first night watch was set, I took a small boat, wrapped myself in fur and kept a brazier beside me, and went alone to Mid-Lake Pavilion to see the snow. Frost mist spread in a white haze. Sky and cloud, mountain and water, above and below, were all one whiteness. The only shadows on the lake were a single trace of the long causeway, one dot of the pavilion, my boat no larger than a mustard seed, and the two or three people aboard, mere grains.`,
    preflight: [
      '“更定”译为 first night watch was set 采用传统夜更解释，但具体时刻与动作含义仍可讨论。',
      '“拥毳衣炉火”不是简单“带着火盆”，译文拆成裹裘与身旁火盆，可能削弱紧凑结构。',
      '“雾凇沆砀”不同版本和注家对霜雾、水气弥漫的解释有差异，white haze 只保住视觉效果。',
      '“两三粒”故意把人缩为颗粒，译文 mere grains 保留尺度，却补了评价性 mere。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-shenfu-childhood-vision',
      direction: 'zh_to_en',
      category: 'literary',
      sourceForm: 'classical_chinese_prose',
      genre: 'autobiographical reminiscence',
      era: 'early_modern',
      canonicality: 'medium',
      sourceText:
        '余忆童稚时，能张目对日，明察秋毫。见藐小微物，必细察其纹理，故时有物外之趣。夏蚊成雷，私拟作群鹤舞空，心之所向，则或千或百，果然鹤也。昂首观之，项为之强。又留蚊于素帐中，徐喷以烟，使其冲烟飞鸣，作青云白鹤观，果如鹤唳云端，为之怡然称快。',
      taskBrief:
        'Translate this complete childhood-imagination episode into clear, lively literary English. Preserve the retrospective voice, transformations of mosquitoes into cranes, physical comedy, and the boundary between perceived fact and imaginative play.',
      difficultyTags: [
        'classical-compression',
        'childhood-perspective',
        'imagined-transformation',
        'idiom',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 1,
      },
      source: {
        author: '沈复',
        title: '浮生六记·闲情记趣',
        edition:
          '《浮生六记》卷二正文；中文维基文库简体转录，检索于 2026-07-28',
        url: 'https://zh.wikisource.org/zh-hans/%E6%B5%AE%E7%94%9F%E5%85%AD%E8%A8%98/%E5%8D%B7%E4%BA%8C_%E9%96%91%E6%83%85%E8%A8%98%E8%B6%A3',
        excerptBounds:
          '开头完整蚊鹤想象单元，从“余忆童稚时”至“为之怡然称快”。',
        rightsBasis:
          '清代作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否准确处理 张目对日、明察秋毫、物外之趣 与 项为之强',
        '是否区分真实蚊群、私拟为鹤和“果然鹤也”的主观视觉',
        '是否让烟、素帐、青云白鹤的人工场景连贯',
        '是否保留儿童想象的认真与喜剧感，而不改成成人解释',
      ],
    }),
    translation: `I remember that as a small child I could stare wide-eyed at the sun and discern the finest details. Whenever I saw some tiny thing, I would examine its patterns closely, and so I often found delights beyond the objects themselves. In summer, mosquitoes thundered. In private I imagined them as flocks of cranes dancing in the sky. Once my mind was set upon it, whether there were hundreds or thousands, they truly became cranes. I watched with my head raised until my neck grew stiff. I would also keep mosquitoes inside a plain gauze canopy and slowly blow smoke among them, making them fly and cry through it. I viewed the scene as white cranes in blue clouds. It truly resembled cranes calling at the edge of heaven, and I clapped with delight.`,
    preflight: [
      '“张目对日”直译 stare at the sun 可能让读者误以为长时间直视，原意更重视目力。',
      '“明察秋毫”译为 discern the finest details 丢失“秋毫”典故，但避免英语中生硬的 autumn hair。',
      '“物外之趣”译为 delights beyond the objects themselves 偏哲学，原文也可理解为超出日常事物的想象乐趣。',
      '“怡然称快”译为 clapped with delight 加入了拍手动作，原文只有怡然赞快，属于明显可能增译。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-wanganshi-reform-defense',
      direction: 'zh_to_en',
      category: 'cultural_argument',
      sourceForm: 'classical_chinese_prose',
      genre: 'political letter and policy argument',
      era: 'medieval',
      canonicality: 'high',
      sourceText:
        '盖儒者所争，尤在于名实。名实已明，而天下之理得矣。今君实所以见教者，以为侵官、生事、征利、拒谏，以致天下怨谤也。某则以谓受命于人主，议法度而修之于朝廷，以授之于有司，不为侵官；举先王之政，以兴利除弊，不为生事；为天下理财，不为征利；辟邪说，难壬人，不为拒谏。至于怨谤之多，则固前知其如此也。',
      contextBefore:
        'Wang Anshi replies to Sima Guang’s objections to the New Policies. “君实” is Sima Guang’s courtesy name.',
      taskBrief:
        'Translate this complete argumentative paragraph into precise formal English. Preserve the name-versus-reality framework, the four accusations and four rebuttals, institutional actors, parallel syntax, and the distinction between managing public finance and seeking profit.',
      difficultyTags: [
        'historical-institutions',
        'parallel-rebuttal',
        'political-terminology',
        'classical-compression',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 1,
        preserveParallelism: true,
      },
      source: {
        author: '王安石',
        title: '答司马谏议书',
        edition:
          '《王临川集》卷七十三等所收；中文维基文库 revision 2562156，转为简体字',
        url: 'https://zh.wikisource.org/w/index.php?title=%E7%AD%94%E5%8F%B8%E9%A6%AC%E8%AB%AB%E8%AD%B0%E6%9B%B8&oldid=2562156',
        excerptBounds:
          '第二个完整段落，从“盖儒者所争”至“固前知其如此也”。',
        rightsBasis:
          '北宋作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否让 名实 既保持历史哲学含义又能被英语读者理解',
        '是否逐一对应 侵官、生事、征利、拒谏 与四项反驳',
        '是否区分 人主、朝廷、有司 的制度角色',
        '是否准确处理 辟邪说、难壬人 及末句对怨谤的预见',
      ],
    }),
    translation: `What Confucian scholars contend over lies above all in names and realities. Once names and realities are made clear, the principles governing the world fall into place. Your instruction to me now is that I have usurped official authority, stirred up affairs, exacted profit, and rejected remonstrance, thereby provoking resentment and slander throughout the realm. I, however, maintain that to receive a mandate from the sovereign, deliberate upon institutions, revise them at court, and entrust them to the responsible offices is not to usurp authority; to revive the policies of the former kings in order to promote benefits and remove abuses is not to stir up affairs; to manage public finances for all under Heaven is not to exact profit; and to refute perverse doctrines and challenge flattering men is not to reject remonstrance. As for the abundance of resentment and slander, I had long known beforehand that it would be so.`,
    preflight: [
      '“名实”译为 names and realities 是常见哲学译法，但对不了解名实之辨的读者仍可能不透明。',
      '“法度”译为 institutions 扩大为制度体系，若译 laws and regulations 又可能过窄。',
      '“举先王之政”中的 举 可指施行或兴起，revive 暗示政策曾经中断。',
      '“壬人”译为 flattering men 采取谄佞之人读法，但“难”兼有驳斥与责难，challenge 力度可能偏弱。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-guyanwu-shame',
      direction: 'zh_to_en',
      category: 'cultural_argument',
      sourceForm: 'classical_chinese_prose',
      genre: 'moral and political argument',
      era: 'early_modern',
      canonicality: 'medium',
      sourceText:
        '然而四者之中，耻尤为要。故夫子之论士曰：“行己有耻。”孟子曰：“人不可以无耻。无耻之耻，无耻矣。”又曰：“耻之于人大矣。为机变之巧者，无所用耻焉。”所以然者，人之不廉，而至于悖礼犯义，其原皆生于无耻也。故士大夫之无耻，是谓国耻。',
      contextBefore:
        'The “four” are ritual propriety, righteousness, integrity, and shame, described earlier as the four bonds of a state.',
      taskBrief:
        'Translate this complete argumentative unit into concise formal English. Preserve the distinction among shame, integrity, ritual, and righteousness; mark the embedded quotations; and retain the final escalation from personal shamelessness to national disgrace.',
      difficultyTags: [
        'confucian-terms',
        'embedded-quotation',
        'wordplay',
        'political-morality',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 1,
        preserveQuotations: true,
      },
      source: {
        author: '顾炎武',
        title: '日知录·廉耻',
        edition:
          '《日知录》卷十三《廉耻》；香港教育局古诗文资料 PDF 转录，转为简体字',
        url: 'https://cd.edb.gov.hk/chi/resource/ncs/download/js_list/JS_lianchi.pdf',
        excerptBounds:
          '从“然而四者之中”至“是谓国耻”的完整论证单元。',
        rightsBasis:
          '清代原作为全球公有领域；来源为香港教育局公开教学资料，本数据集仅转录公版原文。',
      },
      reviewerChecklist: [
        '是否区分 耻、廉、礼、义，而没有都泛化成 morality',
        '是否处理“无耻之耻，无耻矣”的词语回环',
        '是否准确理解 为机变之巧者 与 无所用耻焉',
        '是否保留从个人行为根源推到“士大夫之无耻，是谓国耻”的力度',
      ],
    }),
    translation: `Yet among the four, a sense of shame is especially vital. Thus, when the Master spoke of the scholar, he said, “In conducting himself, he has a sense of shame.” Mencius said, “A person cannot be without shame. To be ashamed of having no shame is to be free from shamefulness.” He also said, “Shame is of great importance to a person. Those who are clever at opportunistic shifts have no use for shame.” The reason is that when people lack integrity and go on to violate ritual and offend righteousness, the source of it all lies in shamelessness. Therefore, when the scholar-officials are shameless, that is called the disgrace of the nation.`,
    preflight: [
      '“耻”既是内在羞耻感也是可耻状态，英语 shame/shamefulness 难以完整复制词语回环。',
      '“无耻之耻，无耻矣”有多种断解，当前采用“以无耻为耻，便不再可耻”的常见读法。',
      '“机变之巧”译为 opportunistic shifts 偏向投机，可能弱化权变技巧本身的中性面。',
      '“国耻”可译 national disgrace 或 disgrace to the state；前者在现代英语中可能被理解为国家受辱事件。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-songyingxing-coal-mining',
      direction: 'zh_to_en',
      category: 'nonliterary',
      sourceForm: 'classical_chinese_prose',
      genre: 'mining and ventilation description',
      era: 'early_modern',
      canonicality: 'medium',
      sourceText:
        '凡取煤经历久者，从土面能辨有无之色，然后掘挖，深至五丈许，方始得煤。初见煤端时，毒气灼人。有将巨竹凿去中节，尖锐其末，插入炭中，其毒烟从竹中透上，人从其下施镢拾取者。或一井而下，炭纵横广有，则随其左右阔取。其上支板，以防压崩耳。',
      taskBrief:
        'Translate this complete mining description into precise, readable technical English. Preserve the sequence of surface prospecting, shaft depth, toxic gas ventilation, extraction, and timber support. Retain historical units and do not silently replace the described practice with modern mining terminology.',
      difficultyTags: [
        'historical-technology',
        'mining-terminology',
        'procedural-sequence',
        'safety-description',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 1,
        preserveNumbersAndUnits: true,
      },
      source: {
        author: '宋应星',
        title: '天工开物·煤炭',
        year: 1637,
        edition:
          '《天工开物》正文；中文维基文库 revision 459326，转为简体字',
        url: 'https://zh.wikisource.org/w/index.php?title=%E5%A4%A9%E5%B7%A5%E9%96%8B%E7%89%A9/%E7%85%A4%E7%82%AD&oldid=459326',
        excerptBounds:
          '完整采煤段，从“凡取煤经历久者”至“以防压崩耳”。',
        rightsBasis:
          '明代作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否读清先辨地表颜色、再下掘约五丈的勘探流程',
        '是否准确处理 去中节巨竹排出毒烟的通风方法',
        '是否区分井、煤层横向延展、左右扩采与顶部支板',
        '是否保留 镢、丈 等历史工具和单位而不假装成现代标准工艺',
      ],
    }),
    translation: `Those long experienced in extracting coal can tell from the color of the ground whether coal lies below. They then excavate, and only at a depth of about five zhang do they first reach it. When the edge of the coal is initially exposed, poisonous vapors scorch people. Some hollow out the joints of a great bamboo, sharpen its end, and insert it into the coal. The poisonous fumes pass upward through the bamboo, while workers below wield mattocks and gather the coal. If a shaft descends into a seam extending broadly across and along it, they widen the excavation to either side as the coal runs. Boards are propped overhead simply to prevent a crushing collapse.`,
    preflight: [
      '“毒气灼人”译为 vapors scorch people 保留灼伤感，但毒气可能主要指窒息或刺激，现代术语不可反推。',
      '“人从其下”中“其”指竹管下方还是煤层下部，译文选择 workers below，空间关系仍可能有争议。',
      '“施镢拾取”既含掘取也含收集，wield mattocks and gather 拆成两步可能过度细化。',
      '“炭纵横广有”译成 seam extending broadly 是现代地质化理解，原文只是描述煤炭横纵广布。',
    ],
  },
  {
    sample: sample({
      id: 'test-zh-en-shenkuo-magnetic-needle',
      direction: 'zh_to_en',
      category: 'nonliterary',
      sourceForm: 'classical_chinese_prose',
      genre: 'experimental technical observation',
      era: 'medieval',
      canonicality: 'high',
      sourceText:
        '方家以磁石磨针锋，则能指南，然常微偏东，不全南也。水浮多荡摇，指爪及碗唇上，皆可为之，运转尤速，但坚滑易坠，不若缕悬为最善。其法取新纩中独茧缕，以芥子许蜡缀于针腰，无风处悬之，则针常指南。其中有磨而指北者，予家指南北者皆有之。磁石之指南，犹柏之指西，莫可原其理。',
      taskBrief:
        'Translate this complete technical observation into precise, readable English. Preserve the comparison of suspension methods, the construction details, the observation of declination and opposite polarity, and the author’s explicit uncertainty. Do not retrofit modern magnetic theory into the text.',
      difficultyTags: [
        'experimental-observation',
        'historical-instrument',
        'technical-comparison',
        'epistemic-humility',
      ],
      deterministicConstraints: {
        preserveParagraphs: true,
        expectedParagraphs: 1,
        preserveMeasurements: true,
      },
      source: {
        author: '沈括',
        title: '梦溪笔谈·磁石指南柏指西',
        edition:
          '《梦溪笔谈》相关条目，见《事实类苑》卷五十八所录；中文维基文库正文，转为简体字',
        url: 'https://zh.wikisource.org/wiki/%E4%BA%8B%E5%AF%A6%E9%A1%9E%E8%8B%91/%E5%8D%B758#%E7%A3%81%E7%9F%B3%E6%8C%87%E5%8D%97%E6%9F%8F%E6%8C%87%E8%A5%BF',
        excerptBounds:
          '“磁石指南柏指西”条全文，从“方家以磁石磨针锋”至“莫可原其理”。',
        rightsBasis:
          '北宋作品为全球公有领域；所引维基文库数字转录采用 CC BY-SA 4.0。',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      reviewerChecklist: [
        '是否准确处理磁针微偏东而非正南的观测',
        '是否区分水浮、指甲或碗沿承托、丝缕悬挂三种方法及优缺点',
        '是否译清独茧缕、芥子许蜡、缀于针腰的制作细节',
        '是否保留有的针指南、有的指北和作者“不知其理”的认识边界',
      ],
    }),
    translation: `Experts rub the point of a needle with lodestone, whereupon it can indicate south, though it commonly inclines slightly east and does not point due south. Floating it on water causes much rocking. It may also be balanced on a fingernail or the rim of a bowl, where it turns especially fast, but the hard, smooth surfaces let it fall easily. Suspension by a thread is best. The method is to take a single cocoon filament from fresh floss, attach it to the needle’s waist with a speck of wax the size of a mustard seed, and hang it where there is no wind. The needle will then consistently point south. Some needles, however, point north after being rubbed. In my household we have both south-pointing and north-pointing ones. That lodestone points south is like the cypress pointing west: the principle cannot be traced.`,
    preflight: [
      '“方家”译为 experts 方便阅读，但原词可能更接近掌握方术或专门技艺者。',
      '“指爪及碗唇上”是把针置于指甲或碗沿，balanced 是合理补足，却没有说明实际支点构造。',
      '“新纩中独茧缕”涉及蚕丝材料，single cocoon filament from fresh floss 术语仍需核验。',
      '末句“柏之指西”本身是古代物性说，译文不解释来源，能保留认识边界但英语读者可能完全不明其比拟。',
    ],
  },
]

function quoteMarkdown(text) {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}  ` : '>'))
    .join('\n')
}

function directionLabel(direction) {
  return direction === 'en_to_zh' ? '英译中' : '中译英'
}

function categoryLabel(category) {
  return {
    poetry: '诗歌与形式文本',
    literary: '文学叙事与人物声音',
    cultural_argument: '文化负载与论辩文本',
    nonliterary: '非文学高密度文本',
  }[category]
}

function englishWordCount(text) {
  return (
    text.match(
      /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu,
    ) ?? []
  ).length
}

function hanCharacterCount(text) {
  return (text.match(/\p{Script=Han}/gu) ?? []).length
}

function lengthLabel(value) {
  if (value.sourceForm === 'poetry') {
    const lines = value.sourceText
      .split(/\r?\n/)
      .filter((line) => line.trim()).length
    return `全诗（含小序时一并计入），${lines} 个非空行`
  }
  if (value.sourceForm === 'english_prose') {
    return `${englishWordCount(value.sourceText)} 个英文词`
  }
  return `${hanCharacterCount(value.sourceText)} 个汉字`
}

const candidateJsonl = `${records
  .map(({ sample: value }) => JSON.stringify(value))
  .join('\n')}\n`

const reviewJsonl = `${records
  .map(({ sample: value, translation, preflight }) =>
    JSON.stringify({
      sampleId: value.id,
      generatorType: 'codex-direct',
      generatedAt,
      protocol: 'fsbp-v1',
      raw: translation,
      body: translation,
      annotation: null,
      preflightRisks: preflight,
      humanReview: {
        status: 'pending',
        issues: [],
        notes: '',
      },
    }),
  )
  .join('\n')}\n`

const markdown = `# FSBP 锁定测试集候选 · 第一轮集中审阅

状态：待人工审阅（0/16）  
生成方式：Codex 在当前会话中直接翻译，未调用项目工作流  
协议：译文只含 \`body\`，未生成注释  
文字规范：中文内容统一为简体字；古籍只转换字形，不改原文词句  
用途：你标出的真实问题将作为后续筛选误导式注释的依据。

## 这次怎样减少你的工作量

每篇都附有“Codex 预审风险点”。它不是替你下结论，而是把我已经能发现的歧义、
增译、术语和文体风险先列出来。你可以直接确认、否决或补充，不必从空白开始。
正式收入测试集前仍以你的逐项结论为准。

---

${records
  .map(
    ({ sample: value, translation, preflight }, index) => `## ${index + 1}. ${value.id}

作者 / 作品：${value.source.author}《${value.source.title}》  
类别：${directionLabel(value.direction)} · ${categoryLabel(value.category)}  
来源：${value.source.edition}  
范围：${value.source.excerptBounds}
长度：${lengthLabel(value)}

### 原文

${quoteMarkdown(value.sourceText)}

### Codex 直译结果

${quoteMarkdown(translation)}

### Codex 预审风险点

${preflight.map((item, itemIndex) => `${itemIndex + 1}. ${item}`).join('\n')}

### 人工标注

- 状态：待审
- 已确认问题：
- 对预审风险点的修正：
- 其他问题：
- 严重度：
- 备注：

---`,
  )
  .join('\n\n')}
`

await mkdir(path.join(root, 'selection'), { recursive: true })
await mkdir(path.join(root, 'private', 'review'), { recursive: true })
await writeFile(
  path.join(root, 'selection', 'test-candidates-round-01.jsonl'),
  candidateJsonl,
  'utf8',
)
await writeFile(
  path.join(root, 'private', 'review', 'test-round-01.jsonl'),
  reviewJsonl,
  'utf8',
)
const reviewMarkdownPath = path.join(
  root,
  'private',
  'review',
  'test-round-01.md',
)
let reviewMarkdownExists = true
try {
  await access(reviewMarkdownPath)
} catch {
  reviewMarkdownExists = false
}

if (!reviewMarkdownExists || overwriteReview) {
  await writeFile(reviewMarkdownPath, markdown, 'utf8')
}

process.stdout.write(
  `Generated ${records.length} test candidates and machine review data. ` +
    (reviewMarkdownExists && !overwriteReview
      ? 'Preserved the existing human review Markdown.\n'
      : 'Generated the human review Markdown.\n'),
)
