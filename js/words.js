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
      ['Taco', 'Burrito'], ['Sushi', 'Sashimi'], ['Lemon', 'Lime'],
      ['Beer', 'Wine'], ['Chocolate', 'Caramel'], ['Pancake', 'Waffle'],
      ['Bread', 'Toast'], ['Ketchup', 'Mustard'], ['Soup', 'Stew'],
      ['Yogurt', 'Cheese'], ['Donut', 'Bagel'], ['Whisky', 'Rum'],
      ['Popcorn', 'Nachos'], ['Fries', 'Wedges'],
      ['Apple', 'Pear'], ['Grape', 'Cherry'], ['Rice', 'Pasta'],
      ['Cookie', 'Cracker'], ['Curry', 'Chili'], ['Smoothie', 'Juice'],
      ['Bacon', 'Sausage'], ['Muffin', 'Cupcake'], ['Cereal', 'Oatmeal'],
      ['Pickle', 'Olive'],
    ],
  },
  {
    id: 'animals', name: 'Animals', pairs: [
      ['Cat', 'Tiger'], ['Dog', 'Wolf'], ['Frog', 'Toad'],
      ['Rabbit', 'Hare'], ['Otter', 'Beaver'], ['Turtle', 'Tortoise'],
      ['Bee', 'Wasp'], ['Butterfly', 'Moth'], ['Leopard', 'Cheetah'],
      ['Dolphin', 'Shark'], ['Peacock', 'Flamingo'], ['Donkey', 'Mule'],
      ['Horse', 'Zebra'], ['Lion', 'Panther'], ['Monkey', 'Gorilla'],
      ['Duck', 'Goose'], ['Sheep', 'Goat'], ['Elephant', 'Rhino'],
      ['Snail', 'Slug'], ['Eagle', 'Hawk'],
      ['Camel', 'Llama'], ['Koala', 'Sloth'], ['Penguin', 'Seal'],
      ['Owl', 'Parrot'], ['Seahorse', 'Starfish'], ['Squirrel', 'Raccoon'],
      ['Fox', 'Deer'], ['Bear', 'Boar'], ['Crab', 'Lobster'],
      ['Spider', 'Scorpion'],
    ],
  },
  {
    id: 'places', name: 'Places & Travel', pairs: [
      ['Beach', 'Desert'], ['Mountain', 'Hill'], ['Hotel', 'Motel'],
      ['Airport', 'Station'], ['Museum', 'Gallery'], ['Castle', 'Palace'],
      ['Village', 'Town'], ['River', 'Canal'], ['Bridge', 'Tunnel'],
      ['Park', 'Garden'], ['Island', 'Peninsula'], ['Cabin', 'Cottage'],
      ['Library', 'Bookshop'], ['Restaurant', 'Cafe'], ['Forest', 'Jungle'],
      ['Farm', 'Ranch'], ['Harbor', 'Pier'], ['Cave', 'Mine'],
      ['Zoo', 'Aquarium'], ['Stadium', 'Arena'],
      ['School', 'University'], ['Hospital', 'Pharmacy'], ['Bakery', 'Butcher'],
      ['Bank', 'Post Office'], ['Church', 'Temple'], ['Lighthouse', 'Windmill'],
      ['Market', 'Mall'], ['Ferry', 'Yacht'], ['Vineyard', 'Orchard'],
      ['Gym', 'Spa'],
    ],
  },
  {
    id: 'objects', name: 'Household Objects', pairs: [
      ['Pen', 'Pencil'], ['Sofa', 'Chair'], ['Cup', 'Mug'],
      ['Plate', 'Bowl'], ['Fork', 'Spoon'], ['Blanket', 'Quilt'],
      ['Curtain', 'Blind'], ['Mirror', 'Window'], ['Broom', 'Mop'],
      ['Candle', 'Lamp'], ['Clock', 'Watch'], ['Pillow', 'Cushion'],
      ['Knife', 'Scissors'], ['Towel', 'Napkin'], ['Bucket', 'Basket'],
      ['Bottle', 'Jar'], ['Fan', 'Heater'], ['Comb', 'Brush'],
      ['Kettle', 'Teapot'], ['Soap', 'Shampoo'],
      ['Key', 'Lock'], ['Umbrella', 'Raincoat'], ['Ladder', 'Stool'],
      ['Hammer', 'Wrench'], ['Rope', 'Chain'], ['Backpack', 'Suitcase'],
      ['Nail', 'Screw'], ['Drawer', 'Shelf'], ['Toothbrush', 'Razor'],
      ['Stapler', 'Tape'],
    ],
  },
  {
    id: 'nature', name: 'Nature & Weather', pairs: [
      ['Sun', 'Moon'], ['Rain', 'Snow'], ['Sunrise', 'Sunset'],
      ['Lake', 'Pond'], ['Cloud', 'Smoke'], ['Storm', 'Hurricane'],
      ['Ice', 'Frost'], ['Leaf', 'Petal'], ['Rock', 'Pebble'],
      ['Wind', 'Breeze'], ['Volcano', 'Geyser'], ['Star', 'Comet'],
      ['Thunder', 'Lightning'], ['Sand', 'Dust'], ['Cliff', 'Dune'],
      ['Waterfall', 'Rapids'], ['Valley', 'Canyon'], ['Tornado', 'Whirlpool'],
      ['Glacier', 'Iceberg'], ['Meadow', 'Prairie'],
      ['Tree', 'Bush'], ['Flower', 'Weed'], ['Root', 'Branch'],
      ['Puddle', 'Stream'], ['Reef', 'Shore'], ['Rainbow', 'Aurora'],
      ['Moss', 'Fern'], ['Cactus', 'Palm'], ['Fossil', 'Crystal'],
      ['Icicle', 'Snowflake'],
    ],
  },
  {
    id: 'sports', name: 'Sports & Games', pairs: [
      ['Football', 'Rugby'], ['Tennis', 'Badminton'], ['Chess', 'Checkers'],
      ['Boxing', 'Wrestling'], ['Ski', 'Snowboard'], ['Swimming', 'Diving'],
      ['Baseball', 'Cricket'], ['Marathon', 'Sprint'], ['Poker', 'Blackjack'],
      ['Darts', 'Archery'], ['Surfing', 'Sailing'], ['Hockey', 'Lacrosse'],
      ['Basketball', 'Netball'], ['Golf', 'Croquet'], ['Cycling', 'Skating'],
      ['Karate', 'Judo'], ['Bowling', 'Curling'], ['Volleyball', 'Handball'],
      ['Rowing', 'Kayaking'], ['Climbing', 'Bouldering'],
      ['Dodgeball', 'Kickball'], ['Gymnastics', 'Cheerleading'], ['Frisbee', 'Boomerang'],
      ['Skateboard', 'Scooter'], ['Triathlon', 'Decathlon'], ['Sudoku', 'Crossword'],
      ['Fishing', 'Hunting'], ['Yoga', 'Aerobics'], ['Bungee', 'Skydiving'],
      ['Hopscotch', 'Marbles'],
    ],
  },
  {
    id: 'arts', name: 'Entertainment & Arts', pairs: [
      ['Movie', 'Play'], ['Guitar', 'Violin'], ['Piano', 'Organ'],
      ['Drum', 'Tabla'], ['Painting', 'Sketch'], ['Novel', 'Comic'],
      ['Singer', 'Rapper'], ['Circus', 'Carnival'], ['Magician', 'Clown'],
      ['Ballet', 'Opera'], ['Trumpet', 'Saxophone'], ['Cinema', 'Theatre'],
      ['Flute', 'Clarinet'], ['Poem', 'Song'], ['Mosaic', 'Collage'],
      ['Cartoon', 'Anime'], ['Comedy', 'Drama'], ['Concert', 'Festival'],
      ['Harp', 'Cello'], ['Mural', 'Graffiti'],
      ['Actor', 'Director'], ['Dancer', 'Acrobat'], ['Origami', 'Pottery'],
      ['Photograph', 'Poster'], ['Accordion', 'Harmonica'], ['Banjo', 'Ukulele'],
      ['Mask', 'Costume'], ['Riddle', 'Joke'], ['Documentary', 'Sitcom'],
      ['Tattoo', 'Henna'],
    ],
  },
  {
    id: 'tech', name: 'Technology', pairs: [
      ['Phone', 'Tablet'], ['Laptop', 'Desktop'], ['Email', 'Letter'],
      ['Robot', 'Android'], ['Camera', 'Binoculars'], ['Headphones', 'Earbuds'],
      ['Keyboard', 'Typewriter'], ['Battery', 'Charger'], ['Wifi', 'Bluetooth'],
      ['Drone', 'Helicopter'], ['Speaker', 'Microphone'], ['Mouse', 'Trackpad'],
      ['Monitor', 'Projector'], ['Printer', 'Scanner'], ['Radio', 'Podcast'],
      ['Console', 'Arcade'], ['Satellite', 'Telescope'], ['Router', 'Modem'],
      ['App', 'Website'], ['Joystick', 'Controller'],
      ['Password', 'Fingerprint'], ['Emoji', 'Sticker'], ['Cable', 'Adapter'],
      ['Folder', 'File'], ['Screenshot', 'Recording'], ['Alarm', 'Timer'],
      ['GPS', 'Compass'], ['Calculator', 'Abacus'], ['Elevator', 'Escalator'],
      ['Vending Machine', 'ATM'],
    ],
  },
  {
    id: 'people', name: 'Jobs & People', pairs: [
      ['Doctor', 'Nurse'], ['Teacher', 'Professor'], ['Chef', 'Baker'],
      ['Pilot', 'Sailor'], ['Police', 'Soldier'], ['Actor', 'Model'],
      ['Lawyer', 'Judge'], ['Farmer', 'Gardener'], ['Barber', 'Hairdresser'],
      ['Waiter', 'Bartender'], ['Priest', 'Monk'], ['Detective', 'Spy'],
      ['Firefighter', 'Lifeguard'], ['Painter', 'Plumber'], ['Carpenter', 'Blacksmith'],
      ['Scientist', 'Engineer'], ['Journalist', 'Author'], ['Dentist', 'Surgeon'],
      ['Athlete', 'Coach'], ['Tailor', 'Cobbler'],
      ['King', 'Queen'], ['Pirate', 'Viking'], ['Astronaut', 'Diver'],
      ['Wizard', 'Witch'], ['Cowboy', 'Knight'], ['Cashier', 'Accountant'],
      ['Librarian', 'Curator'], ['Electrician', 'Mechanic'], ['Butler', 'Maid'],
      ['Ninja', 'Samurai'],
    ],
  },
  {
    id: 'body', name: 'Body & Health', pairs: [
      ['Arm', 'Leg'], ['Finger', 'Toe'], ['Heart', 'Lung'],
      ['Eye', 'Ear'], ['Nose', 'Mouth'], ['Hair', 'Beard'],
      ['Bone', 'Muscle'], ['Blood', 'Sweat'], ['Tooth', 'Nail'],
      ['Brain', 'Skull'], ['Knee', 'Elbow'], ['Pill', 'Syrup'],
      ['Wrist', 'Ankle'], ['Lip', 'Cheek'], ['Liver', 'Kidney'],
      ['Palm', 'Sole'], ['Shoulder', 'Hip'], ['Spine', 'Ribs'],
      ['Bandage', 'Plaster'], ['Chin', 'Jaw'],
      ['Thumb', 'Pinky'], ['Neck', 'Waist'], ['Stomach', 'Chest'],
      ['Freckle', 'Wrinkle'], ['Cough', 'Sneeze'], ['Fever', 'Chill'],
      ['Vaccine', 'Antibiotic'], ['Crutch', 'Wheelchair'], ['Thermometer', 'Stethoscope'],
      ['Yawn', 'Hiccup'],
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
