// ============================================================================
// words.js — the built-in word-pair bank.
//
// Each pair is two RELATED-BUT-DISTINCT words. At game start one word of the
// pair goes to the civilians and the other to the undercover(s); which is which
// is randomised per game (see rules.js `assignWordPair`). Pairs are grouped by
// category so a host can theme a round or leave it on "Mixed".
// ============================================================================

export const CATEGORIES = [
  {
    id: 'food', name: 'Food & Drink', pairs: [
      ['Coffee', 'Tea'], ['Pizza', 'Burger'], ['Cake', 'Pie'],
      ['Ice Cream', 'Milkshake'], ['Butter', 'Margarine'], ['Jam', 'Honey'],
      ['Noodles', 'Spaghetti'], ['Sushi', 'Sashimi'], ['Lemon', 'Lime'],
      ['Beer', 'Wine'], ['Chocolate', 'Caramel'], ['Pancake', 'Waffle'],
    ],
  },
  {
    id: 'animals', name: 'Animals', pairs: [
      ['Cat', 'Tiger'], ['Dog', 'Wolf'], ['Frog', 'Toad'],
      ['Rabbit', 'Hare'], ['Crocodile', 'Alligator'], ['Turtle', 'Tortoise'],
      ['Bee', 'Wasp'], ['Butterfly', 'Moth'], ['Leopard', 'Cheetah'],
      ['Dolphin', 'Shark'], ['Crow', 'Raven'], ['Donkey', 'Mule'],
    ],
  },
  {
    id: 'places', name: 'Places & Travel', pairs: [
      ['Beach', 'Desert'], ['Mountain', 'Hill'], ['Hotel', 'Motel'],
      ['Airport', 'Station'], ['Museum', 'Gallery'], ['Castle', 'Palace'],
      ['Village', 'Town'], ['River', 'Canal'], ['Bridge', 'Tunnel'],
      ['Park', 'Garden'], ['Island', 'Peninsula'], ['Cabin', 'Cottage'],
    ],
  },
  {
    id: 'objects', name: 'Household Objects', pairs: [
      ['Pen', 'Pencil'], ['Sofa', 'Chair'], ['Cup', 'Mug'],
      ['Plate', 'Bowl'], ['Fork', 'Spoon'], ['Blanket', 'Quilt'],
      ['Curtain', 'Blind'], ['Mirror', 'Window'], ['Broom', 'Mop'],
      ['Candle', 'Lamp'], ['Clock', 'Watch'], ['Pillow', 'Cushion'],
    ],
  },
  {
    id: 'nature', name: 'Nature & Weather', pairs: [
      ['Sun', 'Moon'], ['Rain', 'Snow'], ['Fog', 'Mist'],
      ['Lake', 'Pond'], ['Cloud', 'Smoke'], ['Storm', 'Hurricane'],
      ['Ice', 'Frost'], ['Leaf', 'Petal'], ['Rock', 'Pebble'],
      ['Wind', 'Breeze'], ['Volcano', 'Geyser'], ['Star', 'Comet'],
    ],
  },
  {
    id: 'sports', name: 'Sports & Games', pairs: [
      ['Football', 'Rugby'], ['Tennis', 'Badminton'], ['Chess', 'Checkers'],
      ['Boxing', 'Wrestling'], ['Ski', 'Snowboard'], ['Swimming', 'Diving'],
      ['Baseball', 'Cricket'], ['Marathon', 'Sprint'], ['Poker', 'Blackjack'],
      ['Darts', 'Archery'], ['Surfing', 'Sailing'], ['Hockey', 'Lacrosse'],
    ],
  },
  {
    id: 'arts', name: 'Entertainment & Arts', pairs: [
      ['Movie', 'Play'], ['Guitar', 'Violin'], ['Piano', 'Organ'],
      ['Drum', 'Tabla'], ['Painting', 'Sketch'], ['Novel', 'Comic'],
      ['Singer', 'Rapper'], ['Circus', 'Carnival'], ['Magician', 'Clown'],
      ['Ballet', 'Opera'], ['Trumpet', 'Saxophone'], ['Cinema', 'Theatre'],
    ],
  },
  {
    id: 'tech', name: 'Technology', pairs: [
      ['Phone', 'Tablet'], ['Laptop', 'Desktop'], ['Email', 'Letter'],
      ['Robot', 'Android'], ['Camera', 'Binoculars'], ['Headphones', 'Earbuds'],
      ['Keyboard', 'Typewriter'], ['Battery', 'Charger'], ['Wifi', 'Bluetooth'],
      ['Drone', 'Helicopter'], ['Speaker', 'Microphone'], ['Mouse', 'Trackpad'],
    ],
  },
  {
    id: 'people', name: 'Jobs & People', pairs: [
      ['Doctor', 'Nurse'], ['Teacher', 'Professor'], ['Chef', 'Baker'],
      ['Pilot', 'Sailor'], ['Police', 'Soldier'], ['Actor', 'Model'],
      ['Lawyer', 'Judge'], ['Farmer', 'Gardener'], ['Barber', 'Hairdresser'],
      ['Waiter', 'Bartender'], ['Priest', 'Monk'], ['Detective', 'Spy'],
    ],
  },
  {
    id: 'body', name: 'Body & Health', pairs: [
      ['Arm', 'Leg'], ['Finger', 'Toe'], ['Heart', 'Lung'],
      ['Eye', 'Ear'], ['Nose', 'Mouth'], ['Hair', 'Beard'],
      ['Bone', 'Muscle'], ['Blood', 'Sweat'], ['Tooth', 'Nail'],
      ['Brain', 'Skull'], ['Knee', 'Elbow'], ['Pill', 'Syrup'],
    ],
  },
];

export const MIXED = 'mixed';

/** All pairs across every category, tagged with their category id. */
export function allPairs() {
  return CATEGORIES.flatMap((c) => c.pairs.map((pair) => ({ pair, category: c.id })));
}

/** Pairs available for a chosen category id, or the whole bank for "mixed". */
export function pairsForCategory(categoryId) {
  if (!categoryId || categoryId === MIXED) return allPairs();
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  return cat ? cat.pairs.map((pair) => ({ pair, category: cat.id })) : allPairs();
}

/** Metadata for the lobby category picker (Mixed first, then each category). */
export function categoryOptions() {
  return [
    { id: MIXED, name: 'Mixed', count: allPairs().length },
    ...CATEGORIES.map((c) => ({ id: c.id, name: c.name, count: c.pairs.length })),
  ];
}
