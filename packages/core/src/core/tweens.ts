/*
 * velocity-animate (C) 2014-2018 Julian Shapiro.
 *
 * Licensed under the MIT license. See LICENSE file in the project root for details.
 *
 * Tweens
 */

import {
	KnownElement, Properties, Sequence,
	VelocityProperty, VelocityPropertyValueFn, VelocityTween,
} from "../velocity";
import { isFunction, isNumber, isString } from "../types";
import { cloneArray } from "../utility";
import { Velocity } from "../velocity";
import { camelCase } from "./camelCase";
import { fixColors } from "../css/fixColors";
import { getPropertyValue } from "../css/getPropertyValue";
import { Data } from "../data";
import { Easings, validateEasing } from "../easings";
import { getNormalization, getNormalizationUnit } from "../normalizations";
import { IAnimation, symbolElements } from "./animation";
import { AnimationCall, AnimationFlags } from "./animationCall";

type CommandType = {
	[type: string]: (
		value: any,
		element: KnownElement,
		elements: IAnimation,
		elementArrayIndex: number,
		propertyName: string,
		tween: VelocityTween
	) => string;
};

const rxHex = /^#([A-f\d]{3}){1,2}$/i;
const commands: CommandType = {
	function: (value, element, elements, elementArrayIndex, propertyName, _tween) => {
		return String((value as any as VelocityPropertyValueFn).call(element, elementArrayIndex, elements.length, propertyName));
	},
	number: (value, _element, _elements, _elementArrayIndex, _propertyName, tween) => {
		return String(value) + getNormalizationUnit(tween.fn);
	},
	string: (value, _element, _elements, _elementArrayIndex, _propertyName, _tween) => {
		return fixColors(value);
	},
	undefined: (_value, element, _elements, _elementArrayIndex, propertyName, tween) => {
		return fixColors(getPropertyValue(element, propertyName, tween.fn) || "");
	},
};

/**
 * Expand a VelocityProperty argument into a valid sparse Tween array. This
 * pre-allocates the array as it is then the correct size and slightly
 * faster to access.
 */
export function expandProperties(activeCall: AnimationCall, properties: Properties<VelocityProperty>) {
	const tweens = activeCall.tweens = Object.create(null);
	const { animation, duration, element, queue } = activeCall;
	const elements = animation[symbolElements];
	const elementArrayIndex = elements.indexOf(element);
	const data = Data(element);

	for (const property in properties) {
		if (properties.hasOwnProperty(property)) {
			const propertyName = camelCase(property);
			const fn = getNormalization(element, propertyName);
			let valueData = properties[property];

			if (!fn && propertyName !== "tween") {
				if (Velocity.debug) {
					console.log(`Skipping "${property}" due to a lack of browser support.`);
				}
				continue;
			}
			if (valueData == null) {
				if (Velocity.debug) {
					console.log(`Skipping "${property}" due to no value supplied.`);
				}
				continue;
			}
			const tween: VelocityTween = tweens[propertyName] = {} as any;
			let endValue: string;
			let startValue: string | undefined;

			tween.fn = fn!;
			if (isFunction(valueData)) {
				// If we have a function as the main argument then resolve
				// it first, in case it returns an array that needs to be
				// split.
				valueData = valueData.call(element, elementArrayIndex, elements.length, elements);
			}
			if (Array.isArray(valueData)) {
				// valueData is an array in the form of
				// [ endValue, [, easing] [, startValue] ]
				const arr1 = valueData[1];
				const arr2 = valueData[2];

				endValue = valueData[0] as any;
				if ((isString(arr1) && (/^[\d-]/.test(arr1) || rxHex.test(arr1))) || isFunction(arr1) || isNumber(arr1)) {
					startValue = arr1 as any;
				} else if ((isString(arr1) && Easings[arr1]) || Array.isArray(arr1)) {
					tween.easing = validateEasing(arr1, duration);
					startValue = arr2 as any;
				} else {
					startValue = arr1 || arr2 as any;
				}
			} else {
				endValue = valueData as any;
			}
			tween.end = commands[typeof endValue](endValue, element, animation, elementArrayIndex, propertyName, tween) as any;
			if (startValue != null || (queue === false || data.queueList[queue] === undefined)) {
				tween.start = commands[typeof startValue!](startValue!, element, animation, elementArrayIndex, propertyName, tween) as any;
				explodeTween(propertyName, tween, duration);
			}
		}
	}
}

// TODO: Needs a better match for "translate3d" etc - a number must be preceded by some form of break...
const rxToken = /((?:[+\-*/]=)?(?:[+-]?\d*\.\d+|[+-]?\d+)[a-z%]*|(?:.(?!$|[+-]?\d|[+\-*/]=[+-]?\d))+.|.)/g;
const rxNumber = /^([+\-*/]=)?([+-]?\d*\.\d+|[+-]?\d+)(.*)$/;

/**
 * Find a pattern between multiple strings, return a VelocitySequence with
 * the pattern and the tokenised values.
 *
 * If number then animate.
 * If a string then must match.
 * If units then convert between them by wrapping in a calc().
 * - If already in a calc then nest another layer.
 * If in an rgba() then the first three numbers are rounded.
 */
export function findPattern(parts: ReadonlyArray<string>, propertyName: string): Sequence | undefined {
	const partsLength = parts.length;
	const tokens: string[][] = [];
	const indexes: number[] = [];
	let numbers: boolean;

	// First tokenise the strings - these have all values, we will pull
	// numbers later.
	for (let part = 0; part < partsLength; part++) {
		if (isString(parts[part])) {
			if (parts[part] === "") {
				tokens[part] = [""];
			} else {
				tokens[part] = cloneArray(parts[part].match(rxToken)!);
			}
			indexes[part] = 0;
			// If it matches more than one thing then we've got a number.
			numbers = numbers! || tokens[part].length > 1;
			//console.log(`tokens:`, parts[part], tokens[part])
		} else {
			// We have an incomplete lineup, it will get tried again later...
			return;
		}
	}
	const sequence: Sequence = [] as any;
	const pattern = (sequence.pattern = []) as (string | boolean)[];
	const addString = (text: string) => {
		if (isString(pattern[pattern.length - 1])) {
			pattern[pattern.length - 1] += text;
		} else if (text) {
			pattern.push(text);
			for (let part = 0; part < partsLength; part++) {
				(sequence[part] as any[]).push(null);
			}
		}
	};
	const returnStringType = () => {
		if (numbers || pattern.length > 1) {
			//console.error(`Velocity: Trying to pattern match mis-matched strings "${propertyName}":`, parts);
			return;
		}
		const isDisplay = propertyName === "display";
		const isVisibility = propertyName === "visibility";

		for (let part = 0; part < partsLength; part++) {
			const value = parts[part];

			sequence[part][0] = value;
			// Don't care about duration...
			sequence[part].easing = validateEasing((isDisplay && value === "none") || (isVisibility && value === "hidden") || (!isDisplay && !isVisibility) ? "at-end" : "at-start", 400);
		}
		pattern[0] = false;

		return sequence;
	};
	let more = true;

	for (let part = 0; part < partsLength; part++) {
		sequence[part] = [];
	}
	while (more) {
		const bits: ([number, string] | [number, string, boolean])[] = [];
		const units: string[] = [];
		let text: string | undefined;
		let isUnitless = false;
		let hasNumbers = false;

		for (let part = 0; part < partsLength; part++) {
			const index = indexes[part]++;
			const token = tokens[part][index];

			if (token) {
				const num = token.match(rxNumber); // [ignore, change, number, unit]

				if (num) {
					// It's a number, possibly with a += change and unit.
					if (text) {
						return returnStringType();
					}
					const digits = parseFloat(num[2]);
					const unit = num[3];
					const change = num[1] ? num[1][0] + unit : undefined;
					const changeOrUnit = change || unit;

					if (digits && !units.includes(changeOrUnit)) {
						// Will be an empty string at the least.
						units.push(changeOrUnit);
					}
					if (!unit) {
						if (digits) {
							hasNumbers = true;
						} else {
							isUnitless = true;
						}
					}
					bits[part] = change ? [digits, changeOrUnit, true] : [digits, changeOrUnit];
				} else if (bits.length) {
					return returnStringType();
				} else {
					// It's a string.
					if (!text) {
						text = token;
					} else if (text !== token) {
						return returnStringType();
					}
				}
			} else if (!part) {
				for (; part < partsLength; part++) {
					const index2 = indexes[part]++;

					if (tokens[part][index2]) {
						return returnStringType();
					}
				}
				// IMPORTANT: This is the exit point.
				more = false;
				break;
			} else {
				// Different
				return;
			}
		}
		if (text) {
			addString(text!);
		} else if (units.length) {
			if (units.length === 2 && isUnitless && !hasNumbers) {
				// If we only have two units, and one is empty, and it's only empty on "0", then treat us as having one unit
				units.splice(units[0] ? 1 : 0, 1);
			}
			if (units.length === 1) {
				// All the same units, so append number then unit.
				const unit = units[0];
				const firstLetter = unit[0];

				switch (firstLetter) {
					case "+":
					case "-":
					case "*":
					case "/":
						if (propertyName) {
							console.error(`Velocity: The first property must not contain a relative function "${propertyName}":`, parts);
						}

						return;
				}
				pattern.push(false);
				for (let part = 0; part < partsLength; part++) {
					(sequence[part] as any[]).push(bits[part][0]);
				}
				addString(unit);
			} else {
				// Multiple units, so must be inside a calc.
				addString("calc(");
				const patternCalc = pattern.length - 1; // Store the beginning of our calc.

				for (let i = 0; i < units.length; i++) {
					const unit = units[i];
					const firstLetter = unit[0];
					const isComplex = firstLetter === "*" || firstLetter === "/";
					const isMaths = isComplex || firstLetter === "+" || firstLetter === "-";

					if (isComplex) {
						// TODO: Not sure this should be done automatically!
						pattern[patternCalc] += "(";
						addString(")");
					}
					if (i) {
						addString(` ${isMaths ? firstLetter : "+"} `);
					}
					pattern.push(false);
					for (let part = 0; part < partsLength; part++) {
						const bit = bits[part];
						const value = bit[1] === unit
							? bit[0]
							: bit.length === 3
								? sequence[part - 1][sequence[part - 1].length - 1]
								: isComplex ? 1 : 0;

						(sequence[part] as any[]).push(value);
					}
					addString(isMaths ? unit.substring(1) : unit);
				}
				addString(")");
			}
		}
	}
	// We've got here, so a valid sequence - now check and fix RGB rounding
	// and calc() nesting...
	// TODO: Nested calc(a + calc(b + c)) -> calc(a + (b + c))
	for (let i = 0, inRGB = 0; i < pattern.length; i++) {
		const text = pattern[i];

		if (isString(text)) {
			if (inRGB && (text as string).indexOf(",") >= 0) {
				inRGB++;
			} else if ((text as string).indexOf("rgb") >= 0) {
				inRGB = 1;
			}
		} else if (inRGB) {
			if (inRGB < 4) {
				pattern[i] = true;
			} else {
				inRGB = 0;
			}
		}
	}

	return sequence;
}

/**
 * Convert a string-based tween with start and end strings, into a pattern
 * based tween with arrays.
 */
function explodeTween(propertyName: string, tween: VelocityTween, _duration: number, starting?: boolean) {
	const startValue: string = tween.start!;
	const endValue: string = tween.end!;

	if (!isString(endValue) || !isString(startValue)) {
		return;
	}
	let sequence: Sequence = findPattern([startValue, endValue], propertyName)!;

	if (!sequence && starting) {
		// This little piece will take a startValue, split out the
		// various numbers in it, then copy the endValue into the
		// startValue while replacing the numbers in it to match the
		// original start numbers as a repeating sequence.
		// Finally this function will run again with the new
		// startValue and a now matching pattern.
		const startNumbers = startValue.match(/\d\.?\d*/g) || ["0"];
		const count = startNumbers.length;
		let index = 0;

		sequence = findPattern([endValue.replace(/\d+\.?\d*/g, () => {
			return startNumbers[index++ % count];
		}), endValue], propertyName)!;
	}
	if (sequence) {
		if (Velocity.debug) {
			console.log(`Velocity: Sequence found:`, sequence);
		}
		sequence[0].percent = 0;
		sequence[1].percent = 1;
		tween.sequence = sequence;
		switch (tween.easing) {
			case Easings["at-start"]:
			case Easings["during"]:
			case Easings["at-end"]:
				sequence[0].easing = sequence[1].easing = tween.easing;
				break;
		}
	}
}

/**
 * Expand all queued animations that haven't gone yet
 *
 * This will automatically expand the properties map for any recently added
 * animations so that the start and end values are correct.
 */
export function validateTweens(activeCall: AnimationCall) {
	// Check if we're actually already ready
	if (activeCall.flags & AnimationFlags.EXPANDED) { // tslint:disable-line:no-bitwise
		return;
	}
	const { duration, element, tweens } = activeCall;

	// tslint:disable-next-line:forin
	for (const propertyName in tweens) {
		const tween = tweens[propertyName];

		if (tween.start == null) {
			// Get the start value as it's not been passed in
			const startValue = getPropertyValue(element, propertyName);

			if (isString(startValue)) {
				tween.start = fixColors(startValue);
				explodeTween(propertyName, tween, duration, true);
			} else if (!Array.isArray(startValue)) {
				console.warn(`bad type`, tween, propertyName, startValue);
			}
		}
		if (Velocity.debug) {
			console.log(`tweensContainer "${propertyName}": ${JSON.stringify(tween)}`, element);
		}
	}
	activeCall.flags |= AnimationFlags.EXPANDED; // tslint:disable-line:no-bitwise
}