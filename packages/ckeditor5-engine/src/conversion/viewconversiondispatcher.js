/**
 * @license Copyright (c) 2003-2017, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/**
 * @module engine/conversion/viewconversiondispatcher
 */

import ViewConsumable from './viewconsumable';
import EmitterMixin from '@ckeditor/ckeditor5-utils/src/emittermixin';
import mix from '@ckeditor/ckeditor5-utils/src/mix';
import extend from '@ckeditor/ckeditor5-utils/src/lib/lodash/extend';
import ModelRange from '../model/range';
import ModelPosition from '../model/position';
import ModelTreeWalker from '../model/treewalker';
import ModelNode from '../model/node';
import ModelDocumentFragment from '../model/documentfragment';
import { remove } from '../model/writer';

/**
 * `ViewConversionDispatcher` is a central point of {@link module:engine/view/view view} conversion, which is a process of
 * converting given {@link module:engine/view/documentfragment~DocumentFragment view document fragment} or
 * {@link module:engine/view/element~Element}
 * into another structure. In default application, {@link module:engine/view/view view} is converted to {@link module:engine/model/model}.
 *
 * During conversion process, for all {@link module:engine/view/node~Node view nodes} from the converted view document fragment,
 * `ViewConversionDispatcher` fires corresponding events. Special callbacks called "converters" should listen to
 * `ViewConversionDispatcher` for those events.
 *
 * Each callback, as a first argument, is passed a special object `data` that has `input` and `output` properties.
 * `input` property contains {@link module:engine/view/node~Node view node} or
 * {@link module:engine/view/documentfragment~DocumentFragment view document fragment}
 * that is converted at the moment and might be handled by the callback. `output` property should be used to save the result
 * of conversion. Keep in mind that the `data` parameter is customizable and may contain other values - see
 * {@link ~ViewConversionDispatcher#convert}. It is also shared by reference by all callbacks
 * listening to given event. **Note**: in view to model conversion - `data` contains `context` property that is an array
 * of {@link module:engine/model/element~Element model elements}. These are model elements that will be the parent of currently
 * converted view item. `context` property is used in examples below.
 *
 * The second parameter passed to a callback is an instance of {@link module:engine/conversion/viewconsumable~ViewConsumable}. It stores
 * information about what parts of processed view item are still waiting to be handled. After a piece of view item
 * was converted, appropriate consumable value should be {@link module:engine/conversion/viewconsumable~ViewConsumable#consume consumed}.
 *
 * The third parameter passed to a callback is an instance of {@link ~ViewConversionDispatcher}
 * which provides additional tools for converters.
 *
 * Examples of providing callbacks for `ViewConversionDispatcher`:
 *
 *		// Converter for paragraphs (<p>).
 *		viewDispatcher.on( 'element:p', ( evt, data, consumable, conversionApi ) => {
 *			const paragraph = new ModelElement( 'paragraph' );
 *			const schemaQuery = {
 *				name: 'paragraph',
 *				inside: data.context
 *			};
 *
 *			if ( conversionApi.schema.check( schemaQuery ) ) {
 *				if ( !consumable.consume( data.input, { name: true } ) ) {
 *					// Before converting this paragraph's children we have to update their context by this paragraph.
 *					data.context.push( paragraph );
 *					const children = conversionApi.convertChildren( data.input, consumable, data );
 *					data.context.pop();
 *					paragraph.appendChildren( children );
 *					data.output = paragraph;
 *				}
 *			}
 *		} );
 *
 *		// Converter for links (<a>).
 *		viewDispatcher.on( 'element:a', ( evt, data, consumable, conversionApi ) => {
 *			if ( consumable.consume( data.input, { name: true, attributes: [ 'href' ] } ) ) {
 *				// <a> element is inline and is represented by an attribute in the model.
 *				// This is why we are not updating `context` property.
 *				data.output = conversionApi.convertChildren( data.input, consumable, data );
 *
 *				for ( let item of Range.createFrom( data.output ) ) {
 *					const schemaQuery = {
 *						name: item.name || '$text',
 *						attribute: 'link',
 *						inside: data.context
 *					};
 *
 *					if ( conversionApi.schema.check( schemaQuery ) ) {
 *						item.setAttribute( 'link', data.input.getAttribute( 'href' ) );
 *					}
 *				}
 *			}
 *		} );
 *
 *		// Fire conversion.
 *		// Always take care where the converted model structure will be appended to. If this `viewDocumentFragment`
 *		// is going to be appended directly to a '$root' element, use that in `context`.
 *		viewDispatcher.convert( viewDocumentFragment, { context: [ '$root' ] } );
 *
 * Before each conversion process, `ViewConversionDispatcher` fires {@link ~ViewConversionDispatcher#event:viewCleanup}
 * event which can be used to prepare tree view for conversion.
 *
 * @mixes module:utils/emittermixin~EmitterMixin
 * @fires viewCleanup
 * @fires element
 * @fires text
 * @fires documentFragment
 */
export default class ViewConversionDispatcher {
	/**
	 * Creates a `ViewConversionDispatcher` that operates using passed API.
	 *
	 * @see module:engine/conversion/viewconversiondispatcher~ViewConversionApi
	 * @param {Object} [conversionApi] Additional properties for interface that will be passed to events fired
	 * by `ViewConversionDispatcher`.
	 */
	constructor( conversionApi = {} ) {
		/**
		 * Interface passed by dispatcher to the events callbacks.
		 *
		 * @member {module:engine/conversion/viewconversiondispatcher~ViewConversionApi}
		 */
		this.conversionApi = extend( {}, conversionApi );

		// `convertItem` and `convertChildren` are bound to this `ViewConversionDispatcher` instance and
		// set on `conversionApi`. This way only a part of `ViewConversionDispatcher` API is exposed.
		this.conversionApi.convertItem = this._convertItem.bind( this );
		this.conversionApi.convertChildren = this._convertChildren.bind( this );
	}

	/**
	 * Starts the conversion process. The entry point for the conversion.
	 *
	 * @fires element
	 * @fires text
	 * @fires documentFragment
	 * @param {module:engine/view/documentfragment~DocumentFragment|module:engine/view/element~Element}
	 * viewItem Part of the view to be converted.
	 * @param {Object} [additionalData] Additional data to be passed in `data` argument when firing `ViewConversionDispatcher`
	 * events. See also {@link ~ViewConversionDispatcher#event:element element event}.
	 * @returns {module:engine/model/documentfragment~DocumentFragment} Model document fragment that is a result of the conversion process.
	 */
	convert( viewItem, additionalData = {} ) {
		this.fire( 'viewCleanup', viewItem );

		const consumable = ViewConsumable.createFrom( viewItem );

		const conversionResult = this._convertItem( viewItem, consumable, additionalData );

		if ( conversionResult instanceof ModelNode || conversionResult instanceof ModelDocumentFragment ) {
			const { modelItem, markersData } = extractMarkersFromModelFragment( conversionResult );

			return {
				conversionResult: modelItem,
				markersData: markersData
			};
		}

		return { conversionResult, markersData: new Map() };
	}

	/**
	 * @private
	 * @see module:engine/conversion/viewconversiondispatcher~ViewConversionApi#convertItem
	 */
	_convertItem( input, consumable, additionalData = {} ) {
		const data = extend( {}, additionalData, {
			input: input,
			output: null
		} );

		if ( input.is( 'element' ) ) {
			this.fire( 'element:' + input.name, data, consumable, this.conversionApi );
		} else if ( input.is( 'text' ) ) {
			this.fire( 'text', data, consumable, this.conversionApi );
		} else {
			this.fire( 'documentFragment', data, consumable, this.conversionApi );
		}

		return data.output;
	}

	/**
	 * @private
	 * @see module:engine/conversion/viewconversiondispatcher~ViewConversionApi#convertChildren
	 */
	_convertChildren( input, consumable, additionalData = {} ) {
		const viewChildren = Array.from( input.getChildren() );
		const convertedChildren = viewChildren.map( ( viewChild ) => this._convertItem( viewChild, consumable, additionalData ) );

		// Flatten and remove nulls.
		return convertedChildren.reduce( ( a, b ) => b ? a.concat( b ) : a, [] );
	}

	/**
	 * Fired before the first conversion event, at the beginning of view to model conversion process.
	 *
	 * @event viewCleanup
	 * @param {module:engine/view/documentfragment~DocumentFragment|module:engine/view/element~Element}
	 * viewItem Part of the view to be converted.
	 */

	/**
	 * Fired when {@link module:engine/view/element~Element} is converted.
	 *
	 * `element` is a namespace event for a class of events. Names of actually called events follow this pattern:
	 * `element:<elementName>` where `elementName` is the name of converted element. This way listeners may listen to
	 * all elements conversion or to conversion of specific elements.
	 *
	 * @event element
	 * @param {Object} data Object containing conversion input and a placeholder for conversion output and possibly other
	 * values (see {@link #convert}).
	 * Keep in mind that this object is shared by reference between all callbacks that will be called.
	 * This means that callbacks can add their own values if needed,
	 * and those values will be available in other callbacks.
	 * @param {module:engine/view/element~Element} data.input Converted element.
	 * @param {*} data.output The current state of conversion result. Every change to converted element should
	 * be reflected by setting or modifying this property.
	 * @param {module:engine/model/schema~SchemaPath} data.context The conversion context.
	 * @param {module:engine/conversion/viewconsumable~ViewConsumable} consumable Values to consume.
	 * @param {Object} conversionApi Conversion interface to be used by callback, passed in `ViewConversionDispatcher` constructor.
	 * Besides of properties passed in constructor, it also has `convertItem` and `convertChildren` methods which are references
	 * to {@link #_convertItem} and
	 * {@link ~ViewConversionDispatcher#_convertChildren}. Those methods are needed to convert
	 * the whole view-tree they were exposed in `conversionApi` for callbacks.
	 */

	/**
	 * Fired when {@link module:engine/view/text~Text} is converted.
	 *
	 * @event text
	 * @see #event:element
	 */

	/**
	 * Fired when {@link module:engine/view/documentfragment~DocumentFragment} is converted.
	 *
	 * @event documentFragment
	 * @see #event:element
	 */
}

mix( ViewConversionDispatcher, EmitterMixin );

// Traverses given model item and searches elements which marks marker range. Found element is removed from
// DocumentFragment but path of this element is stored in a Map which is then returned.
//
// @param {module:engine/view/documentfragment~DocumentFragment|module:engine/view/node~Node} modelItem Fragment of model.
// @returns {Object} Object with cleaned up model fragment and Map with markers data.
function extractMarkersFromModelFragment( modelItem ) {
	const markerStamps = new Set();
	const markersData = new Map();

	if ( modelItem.is( 'text' ) ) {
		return { modelItem, markersData };
	}

	// Create ModelTreeWalker.
	const walker = new ModelTreeWalker( {
		startPosition: ModelPosition.createAt( modelItem, 0 ),
		ignoreElementEnd: true,
		shallow: false
	} );

	// Walk through DocumentFragment and collect marker elements.
	for ( const value of walker ) {
		// Check if current element is a marker stamp.
		if ( value.item.name == '$marker' ) {
			markerStamps.add( value.item );
		}
	}

	// Walk through collected marker elements store its path and remove its from the DocumentFragment.
	for ( const stamp of markerStamps ) {
		const markerName = stamp.getAttribute( 'data-name' );
		const currentPosition = ModelPosition.createBefore( stamp );

		// When marker of given name is not stored it means that we have found the beginning of the range.
		if ( !markersData.has( markerName ) ) {
			markersData.set( markerName, { startPath: currentPosition.path } );
			// Otherwise is means that we have found end of the marker range.
		} else {
			markersData.get( markerName ).endPath = currentPosition.path;
		}

		// Remove marker stamp element from DocumentFragment.
		remove( ModelRange.createOn( stamp ) );
	}

	return { modelItem, markersData };
}

/**
 * Model data that is a result of the conversion process.
 *
 * @typedef {Object} engine/conversion/viewconversiondispatcher~ConvertedModelDocument
 * @property {module:engine/model/documentfragment~DocumentFragment|module:engine/model/element~Element|
 * module:engine/model/text~Text} modelItem Model document item.
 * @property {Map} markersData Map with markers data in format [ 'markerName', { startPath: [ 1, 1 ], endPath: [ 1, 4 ] } ]
 */

/**
 * Conversion interface that is registered for given {@link module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher}
 * and is passed as one of parameters when {@link module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher dispatcher}
 * fires it's events.
 *
 * `ViewConversionApi` object is built by {@link module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher} constructor.
 * The exact list of properties of this object is determined by the object passed to the constructor.
 *
 * @interface ViewConversionApi
 */

/**
 * Starts conversion of given item by firing an appropriate event.
 *
 * Every fired event is passed (as first parameter) an object with `output` property. Every event may set and/or
 * modify that property. When all callbacks are done, the final value of `output` property is returned by this method.
 *
 * @method #convertItem
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:element
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:text
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:documentFragment
 * @param {module:engine/view/documentfragment~DocumentFragment|module:engine/view/element~Element|module:engine/view/text~Text}
 * input Item to convert.
 * @param {module:engine/conversion/viewconsumable~ViewConsumable} consumable Values to consume.
 * @param {Object} [additionalData] Additional data to be passed in `data` argument when firing `ViewConversionDispatcher`
 * events. See also {@link module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:element element event}.
 * @returns {*} The result of item conversion, created and modified by callbacks attached to fired event.
 */

/**
 * Starts conversion of all children of given item by firing appropriate events for all those children.
 *
 * @method #convertChildren
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:element
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:text
 * @fires module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:documentFragment
 * @param {module:engine/view/documentfragment~DocumentFragment|module:engine/view/element~Element}
 * input Item which children will be converted.
 * @param {module:engine/conversion/viewconsumable~ViewConsumable} consumable Values to consume.
 * @param {Object} [additionalData] Additional data to be passed in `data` argument when firing `ViewConversionDispatcher`
 * events. See also {@link module:engine/conversion/viewconversiondispatcher~ViewConversionDispatcher#event:element element event}.
 * @returns {Array.<*>} Array containing results of conversion of all children of given item.
 */
