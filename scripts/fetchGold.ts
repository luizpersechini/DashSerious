import { MetalpriceClient } from "../src/metalpriceClient.js";

function ouncesToGrams(ounces: number): number {
	return ounces * 31.1034768; // troy ounces to grams
}

async function main() {
	const client = new MetalpriceClient();
	const resp = await client.fetchLatest({ base: "USD", currencies: ["XAU"] });
	if (!resp.success) {
		throw new Error(`API error ${resp.error?.code}: ${resp.error?.info}`);
	}
	const rate = resp.rates?.["XAU"];
	if (!rate) throw new Error("No XAU rate in response");

	// The API returns how many XAU per 1 USD (or vice versa depending on base). According to docs, rates map has currencies as quote per base.
	// For base=USD and currency=XAU, value is how many XAU one USD buys.
	// We usually want USD per XAU (price of 1 oz). So invert.
	const usdPerXau = 1 / rate;
	const usdPerGram = usdPerXau / ouncesToGrams(1);

	console.log(`Gold (XAU) price:`);
	console.log(`- USD per troy ounce: $${usdPerXau.toFixed(2)}`);
	console.log(`- USD per gram: $${usdPerGram.toFixed(2)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});


