# Prop Shop

Invest in the best traders on Solana to build wealth while you sleep.
As a trader, create a fund to and rapidly scale with crowdsourced capital,
and earn up to a 40% commission on profits earned for your investors.

## Problem Solve

Access to hedge funds and proprietary trading firms (prop shops) on Wall Street is limited to the relatively wealthy,
by requiring an "accredited investor" status. This is generally attained by having a net worth of $1 million or more.
Second to this, there does not exist a system on Solana for profitable traders to create a fund and take on investment.
Prop Shop solves both of these problems -- any trader can create a fund and anyone can invest in it.

Investors can build their wealth while they sleep by letting an experienced trader or algorithm manage their capital.
Traders or a trading algorithm can rapidly scale their assets under management by attracting investment from the public.
The traders, or "fund managers" as they are called, earn up to a 40% commission on profits earned for their investors.

## Development

Prop Shop supports funds on either [Drift](https://www.drift.trade/) or [Phoenix](https://www.phoenix.trade/).
Example bot that trades on Drift and creates a fund on Prop Shop: `driftMomentumBot.ts`.
Example bot that trades on Phoenix and creates a fund on Prop Shop: `phoenixMomentumBot.ts`.

Both bots trade a simple RSI strategy based on this article: [Buy High, Sell Higher](https://quantifi.substack.com/p/buy-high-sell-higher-a-proven-strategy?r=23zkjs&triedRedirect=true)
The idea can use a moving averages or momentum indicators like the RSI.
The bot classes have description in their respective files but the gist is this:
