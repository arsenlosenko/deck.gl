/* eslint-disable guard-for-in */
import {GL, glArrayFromType} from 'luma.gl';
import {log} from './utils';
import assert from 'assert';
function noop() {}

export default class AttributeManager {
  /**
   * @classdesc
   * Automated attribute generation and management. Suitable when a set of
   * vertex shader attributes are generated by iteration over a data array,
   * and updates to these attributes are needed either when the data itself
   * changes, or when other data relevant to the calculations change.
   *
   * - First the application registers descriptions of its dynamic vertex
   *   attributes using AttributeManager.add().
   * - Then, when any change that affects attributes is detected by the
   *   application, the app will call AttributeManager.invalidate().
   * - Finally before it renders, it calls AttributeManager.update() to
   *   ensure that attributes are automatically rebuilt if anything has been
   *   invalidated.
   *
   * The application provided update functions describe how attributes
   * should be updated from a data array and are expected to traverse
   * that data array (or iterable) and fill in the attribute's typed array.
   *
   * Note that the attribute manager intentionally does not do advanced
   * change detection, but instead makes it easy to build such detection
   * by offering the ability to "invalidate" each attribute separately.
   *
   * Summary:
   * - keeps track of valid state for each attribute
   * - auto reallocates attributes when needed
   * - auto updates attributes with registered updater functions
   * - allows overriding with application supplied buffers
   *
   * Limitations:
   * - There are currently no provisions for only invalidating a range of
   *   indices in an attribute.
   *
   * @class
   * @param {Object} [props]
   * @param {String} [props.id] - identifier (for debugging)
   */
  constructor({id = 'attribute-manager'} = {}) {
    this.id = id;
    this.attributes = {};
    this.allocedInstances = -1;
    this.needsRedraw = true;
    this.userData = {};

    this.onUpdateStart = noop;
    this.onUpdateEnd = noop;
    this.onLog = this._defaultLog;

    // For debugging sanity, prevent uninitialized members
    Object.seal(this);
  }

  /**
   * Adds attributes
   * Takes a map of attribute descriptor objects
   * - keys are attribute names
   * - values are objects with attribute fields
   *
   * attribute.size - number of elements per object
   * attribute.updater - number of elements
   * attribute.instanced=0 - is this is an instanced attribute (a.k.a. divisor)
   * attribute.noAlloc=false - if this attribute should not be allocated
   *
   * @example
   * attributeManager.add({
   *   positions: {size: 2, update: calculatePositions}
   *   colors: {size: 3, update: calculateColors}
   * });
   *
   * @param {Object} attributes - attribute map (see above)
   * @param {Object} updaters - separate map of update functions (deprecated)
   */
  add(attributes, updaters = {}) {
    this._add(attributes, updaters);
  }

  // Marks an attribute for update
  invalidate(attributeName) {
    const {attributes} = this;
    const attribute = attributes[attributeName];
    if (!attribute) {
      let message =
        `invalidating non-existent attribute ${attributeName} for ${this.id}\n`;
      message += `Valid attributes: ${Object.keys(attributes).join(', ')}`;
      assert(attribute, message);
    }
    attribute.needsUpdate = true;
    // For performance tuning
    this.onLog(1, `invalidated attribute ${attributeName} for ${this.id}`);
  }

  invalidateAll() {
    const {attributes} = this;
    for (const attributeName in attributes) {
      this.invalidate(attributeName);
    }
  }

  /**
   * Ensure all attribute buffers are updated from props or data.
   *
   * Note: Any preallocated buffers in "buffers" matching registered attribute
   * names will be used. No update will happen in this case.
   * Note: Calls onUpdateStart and onUpdateEnd log callbacks before and after.
   *
   * @param {Object} opts - options
   * @param {Object} opts.data - data (iterable object)
   * @param {Object} opts.numInstances - count of data
   * @param {Object} opts.buffers = {} - pre-allocated buffers
   * @param {Object} opts.props - passed to updaters
   * @param {Object} opts.context - Used as "this" context for updaters
   */
  update({
    data,
    numInstances,
    buffers = {},
    props = {},
    context = {},
    ignoreUnknownAttributes = false
  } = {}) {
    // First apply any application provided buffers
    this._checkExternalBuffers({buffers, ignoreUnknownAttributes});
    this._setExternalBuffers(buffers);

    // Only initiate alloc/update (and logging) if actually needed
    if (this._analyzeBuffers({numInstances})) {
      this.onUpdateStart(this.id);
      this._updateBuffers({numInstances, data, props, context});
      this.onUpdateEnd(this.id);
    }
  }

  /**
   * Sets log functions to help trace or time attribute updates.
   * Default logging uses luma logger.
   *
   * Note that the app may not be in control of when update is called,
   * so hooks are provided for update start and end.
   *
   * @param {Object} [opts]
   * @param {String} [opts.onLog=] - called to print
   * @param {String} [opts.onUpdateStart=] - called before update() starts
   * @param {String} [opts.onUpdateEnd=] - called after update() ends
   */
  setLogFunctions({
    onLog,
    onUpdateStart,
    onUpdateEnd
  } = {}) {
    this.onLog = onLog !== undefined ? onLog : this.onLog;
    this.onUpdateStart =
      onUpdateStart !== undefined ? onUpdateStart : this.onUpdateStart;
    this.onUpdateEnd =
      onUpdateEnd !== undefined ? onUpdateEnd : this.onUpdateEnd;
  }

  /**
   * Returns all attribute descriptors
   * Note: Format matches luma.gl Model/Program.setAttributes()
   * @return {Object} attributes - descriptors
   */
  getAttributes() {
    return this.attributes;
  }

  /**
   * Returns changed attribute descriptors
   * This indicates which WebGLBuggers need to be updated
   * @return {Object} attributes - descriptors
   */
  getChangedAttributes({clearChangedFlags = false}) {
    const {attributes} = this;
    const changedAttributes = {};
    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      if (attribute.changed) {
        attribute.changed = attribute.changed && !clearChangedFlags;
        changedAttributes[attributeName] = attribute;
      }
    }
    return changedAttributes;
  }

  /**
   * Returns the redraw flag, optionally clearing it.
   * Redraw flag will be set if any attributes attributes changed since
   * flag was last cleared.
   *
   * @param {Object} [opts]
   * @param {String} [opts.clearRedrawFlags=false] - whether to clear the flag
   * @return {Boolean} - whether a redraw is needed.
   */
  getNeedsRedraw({clearRedrawFlags = false} = {}) {
    let redraw = this.needsRedraw;
    redraw = redraw || this.needsRedraw;
    this.needsRedraw = this.needsRedraw && !clearRedrawFlags;
    return redraw;
  }

  /**
   * Sets the redraw flag.
   * @param {Boolean} redraw=true
   * @return {AttributeManager} - for chaining
   */
  setNeedsRedraw(redraw = true) {
    this.needsRedraw = true;
    return this;
  }

  // DEPRECATED METHODS

  /**
   * @deprecated since version 2.5, use add() instead
   * Adds attributes
   * @param {Object} attributes - attribute map (see above)
   * @param {Object} updaters - separate map of update functions (deprecated)
   */
  addDynamic(attributes, updaters = {}) {
    this._add(attributes, updaters);
  }

  /**
   * @deprecated since version 2.5, use add() instead
   * Adds attributes
   * @param {Object} attributes - attribute map (see above)
   * @param {Object} updaters - separate map of update functions (deprecated)
   */
  addInstanced(attributes, updaters = {}) {
    this._add(attributes, updaters, {instanced: 1});
  }

  // PRIVATE METHODS

  // Default logger
  _defaultLog(level, message) {
    log.log(level, message);
  }

  // Used to register an attribute
  _add(attributes, updaters = {}, _extraProps = {}) {

    const newAttributes = {};

    for (const attributeName in attributes) {
      // support for separate update function map
      // For now, just copy any attributes from that map into the main map
      // TODO - Attribute maps are a deprecated feature, remove
      if (attributeName in updaters) {
        attributes[attributeName] =
          Object.assign({}, attributes[attributeName], updaters[attributeName]);
      }

      const attribute = attributes[attributeName];

      // Check all fields and generate helpful error messages
      this._validate(attributeName, attribute);

      // Initialize the attribute descriptor, with WebGL and metadata fields
      const attributeData = Object.assign(
        {
          // Ensure that fields are present before Object.seal()
          target: undefined,
          isIndexed: false,

          // Reserved for application
          userData: {}
        },
        // Metadata
        attribute,
        {
          // State
          isExternalBuffer: false,
          needsAlloc: false,
          needsUpdate: false,
          changed: false,

          // Luma fields
          size: attribute.size,
          value: attribute.value || null
        },
        _extraProps
      );
      // Sanity - no app fields on our attributes. Use userData instead.
      Object.seal(attributeData);

      // Add to both attributes list (for registration with model)
      this.attributes[attributeName] = attributeData;
    }

    Object.assign(this.attributes, newAttributes);
  }

  _validate(attributeName, attribute) {
    assert(typeof attribute.size === 'number',
      `Attribute definition for ${attributeName} missing size`);

    // Check the updater
    assert(typeof attribute.update === 'function' || attribute.noAlloc,
      `Attribute updater for ${attributeName} missing update method`);
  }

  // Checks that any attribute buffers in props are valid
  // Note: This is just to help app catch mistakes
  _checkExternalBuffers({
    buffers = {},
    ignoreUnknownAttributes = false
  } = {}) {
    const {attributes} = this;
    for (const attributeName in buffers) {
      const attribute = attributes[attributeName];
      if (!attribute && !ignoreUnknownAttributes) {
        throw new Error(`Unknown attribute prop ${attributeName}`);
      }
      // const buffer = buffers[attributeName];
      // TODO - check buffer type
    }
  }

  // Set the buffers for the supplied attributes
  // Update attribute buffers from any attributes in props
  // Detach any previously set buffers, marking all
  // Attributes for auto allocation
  /* eslint-disable max-statements */
  _setExternalBuffers(bufferMap) {
    const {attributes, numInstances} = this;

    // Copy the refs of any supplied buffers in the props
    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      const buffer = bufferMap[attributeName];
      attribute.isExternalBuffer = false;
      if (buffer) {
        if (!(buffer instanceof Float32Array)) {
          throw new Error('Attribute properties must be of type Float32Array');
        }
        if (attribute.auto && buffer.length <= numInstances * attribute.size) {
          throw new Error('Attribute prop array must match length and size');
        }

        attribute.isExternalBuffer = true;
        attribute.needsUpdate = false;
        if (attribute.value !== buffer) {
          attribute.value = buffer;
          attribute.changed = true;
          this.needsRedraw = true;
        }
      }
    }
  }
  /* eslint-enable max-statements */

  /* Checks that typed arrays for attributes are big enough
   * sets alloc flag if not
   * @return {Boolean} whether any updates are needed
   */
  _analyzeBuffers({numInstances}) {
    const {attributes} = this;
    assert(numInstances !== undefined, 'numInstances not defined');

    // Track whether any allocations or updates are needed
    let needsUpdate = false;

    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      if (!attribute.isExternalBuffer) {
        // Do we need to reallocate the attribute's typed array?
        const needsAlloc =
          attribute.value === null ||
          attribute.value.length / attribute.size < numInstances;
        if (needsAlloc && attribute.update) {
          attribute.needsAlloc = true;
          needsUpdate = true;
        }
        if (attribute.needsUpdate) {
          needsUpdate = true;
        }
      }
    }

    return needsUpdate;
  }

  /**
   * @private
   * Calls update on any buffers that need update
   * TODO? - If app supplied all attributes, no need to iterate over data
   *
   * @param {Object} opts - options
   * @param {Object} opts.data - data (iterable object)
   * @param {Object} opts.numInstances - count of data
   * @param {Object} opts.buffers = {} - pre-allocated buffers
   * @param {Object} opts.props - passed to updaters
   * @param {Object} opts.context - Used as "this" context for updaters
   */
  /* eslint-disable max-statements */
  _updateBuffers({numInstances, data, props, context}) {
    const {attributes} = this;

    // Allocate at least one element to ensure a valid buffer
    const allocCount = Math.max(numInstances, 1);

    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];

      // Allocate a new typed array if needed
      if (attribute.needsAlloc) {
        const ArrayType = glArrayFromType(attribute.type || GL.FLOAT);
        attribute.value = new ArrayType(attribute.size * allocCount);
        this.onLog(2, `${this.id}:${attributeName} allocated ${allocCount}`);
        attribute.needsAlloc = false;
        attribute.needsUpdate = true;
      }

      // Call updater function if needed
      if (attribute.needsUpdate) {
        const {update} = attribute;
        if (update) {
          this.onLog(2, `${this.id}:${attributeName} updating ${numInstances}`);
          update.call(context, attribute, {data, props, numInstances});
        } else {
          this.onLog(2, `${this.id}:${attributeName} missing update function`);
        }
        attribute.needsUpdate = false;
        attribute.changed = true;
        this.needsRedraw = true;
      }
    }

    this.allocedInstances = allocCount;
  }
  /* eslint-enable max-statements */
}
