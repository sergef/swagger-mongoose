const _ = require('lodash');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const path = require('path');

const allowedTypes = [
  'number',
  'integer',
  'long',
  'float',
  'double',
  'string',
  'password',
  'boolean',
  'date',
  'dateTime',
  'array'
];
let definitions = null;
let swaggerVersion = null;
const v2MongooseProperty = 'x-swagger-mongoose';
const v1MongooseProperty = '_mongoose';
const xSwaggerMongoose = {
  schemaOptions: {},
  additionalProperties: {},
  excludeSchema: {},
  documentIndex: {}
};
let validators = {};

const propertyMap = property => {
  switch (property.type) {
    case 'number':
      switch (property.format) {
        case 'integer':
        case 'long':
        case 'float':
        case 'double':
          return Number;
        default:
          throw new Error(`Unrecognised schema format: ${property.format}`);
      }
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
      return Number;
    case 'string':
    case 'password':
      return String;
    case 'boolean':
      return Boolean;
    case 'date':
    case 'dateTime':
      return Date;
    case 'array':
      return [propertyMap(property.items)];
    default:
      throw new Error(`Unrecognized schema type: ${property.type}`);
  }
};

const convertToJSON = spec => {
  let swaggerJSON = {};
  const type = typeof spec;
  switch (type) {
    case 'object':
      if (spec instanceof Buffer) {
        swaggerJSON = JSON.parse(spec);
      } else {
        swaggerJSON = spec;
      }
      break;
    case 'string':
      swaggerJSON = JSON.parse(spec);
      break;
    default:
      throw new Error('Unknown or invalid spec object');
  }
  return swaggerJSON;
};

const isSimpleSchema = schema => {
  return schema.type && isAllowedType(schema.type);
};

const isAllowedType = type => {
  return allowedTypes.indexOf(type) !== -1;
};

const isPropertyHasRef = property => {
  return property.$ref || (property.type === 'array' && property.items.$ref);
};

const fillRequired = (object, key, template) => {
  if (template && Array.isArray(template) && template.indexOf(key) >= 0) {
    object[key].required = true;
  } else if (typeof template === 'boolean') {
    object[key].required = template;
  }
};

const applyExtraDefinitions = (defs, _extraDefinitions) => {
  if (_extraDefinitions) {
    //TODO: check for string or object assume object for now.
    // var extraDefinitions = JSON.parse(_extraDefinitions);
    const mongooseProperty = getMongooseProperty();

    //remove default object from extra, we're going to handle that seperately
    let defaultDefs;
    if (!_extraDefinitions.default) {
      defaultDefs = null;
    } else {
      defaultDefs = _extraDefinitions.default;
      delete _extraDefinitions.default;
      _.each(defs, val => {
        //lets add that default to everything.
        val[mongooseProperty] = defaultDefs;
      });
    }

    const extraDefinitions = _extraDefinitions;
    _.each(extraDefinitions, (val, key) => {
      defs[key][mongooseProperty] = val;
    });
  }
};

const isAtLeastSwagger2 = () => {
  return swaggerVersion >= 2;
};

const getMongooseProperty = () => {
  return isAtLeastSwagger2() ? v2MongooseProperty : v1MongooseProperty;
};

const isMongooseProperty = property => {
  return !!property[getMongooseProperty()];
};

const isMongooseArray = property => {
  return property.items && property.items[getMongooseProperty()];
};

const getMongooseSpecific = (props, property) => {
  const mongooseProperty = getMongooseProperty();
  let mongooseSpecific = property[mongooseProperty];
  let ref =
    isAtLeastSwagger2() && mongooseSpecific
      ? mongooseSpecific.$ref
      : property.$ref;

  if (!mongooseSpecific && isMongooseArray(property)) {
    mongooseSpecific = property.items[mongooseProperty];
    ref = isAtLeastSwagger2() ? mongooseSpecific.$ref : property.items.$ref;
  }

  if (!mongooseSpecific) {
    return props;
  }

  let ret = {};
  if (ref) {
    if (!isAtLeastSwagger2()) {
      if (mongooseSpecific.type === 'objectId') {
        ret.type = Schema.Types.ObjectId;
        if (mongooseSpecific.includeSwaggerRef !== false) {
          ret.ref = ref.replace('#/definitions/', '');
        }
      }
    } else {
      ret.type = Schema.Types.ObjectId;
      ret.ref = ref.replace('#/definitions/', '');
    }
  } else if (mongooseSpecific.validator) {
    const validator = validators[mongooseSpecific.validator];
    ret = _.extend(ret, property, { validate: validator });
    delete ret[mongooseProperty];
  } else {
    ret = _.extend(ret, property, mongooseSpecific);
    delete ret[mongooseProperty];
    if (isSimpleSchema(ret)) {
      ret.type = propertyMap(ret);
    }
  }

  return ret;
};

const isMongodbReserved = fieldKey => {
  return fieldKey === '_id' || fieldKey === '__v';
};

const processRef = (property, objectName, props, key, required) => {
  const refRegExp = /^#\/definitions\/(\w*)$/;
  const refString = property.$ref ? property.$ref : property.items.$ref;
  const propType = refString.match(refRegExp)[1];
  // NOT circular reference
  if (propType !== objectName) {
    const object = definitions[propType];
    if (~['array', 'object'].indexOf(object.type)) {
      const schema = getSchema(
        propType,
        object.properties ? object.properties : object
      );
      props[key] =
        property.items || object.type === 'array' ? [schema] : schema;
    } else {
      const clone = _.extend({}, object);
      delete clone[getMongooseProperty()];
      const schemaProp = getSchemaProperty(clone, key)[key];
      props[key] = property.items ? [schemaProp] : schemaProp;
    }
  } else if (propType) { // circular reference
    props[key] = {
      type: Schema.Types.ObjectId,
      ref: propType
    };
  }

  fillRequired(props, key, required);
};

const isPolymorphic = def => {
  return def.allOf;
};

/*
 * Merges members of 'allOf' into a single 'properties' object,
 * and a single 'required' array, and assigns these to the parent definition.
 *
 * NOTE: needs more thorough testing!
 */
const processPolymorphic = definition => {
  const mergedProps = {};
  const mergedReqs = new Set();
  definition.allOf.forEach(polyDef => {
    if (polyDef.$ref) {
      const refRegExp = /^#\/definitions\/(\w*)$/;
      const refString = polyDef.$ref;
      const propType = refString.match(refRegExp)[1];
      const object = definitions[propType];
      Object.assign(mergedProps, object.properties);
      if (object.required) {
        object.required.forEach(req => {
          mergedReqs.add(req);
        });
      }
    } else {
      Object.assign(mergedProps, polyDef.properties);
      if (polyDef.required) {
        polyDef.required.forEach(req => {
          mergedReqs.add(req);
        });
      }
    }
  });
  if (!_.isEmpty(mergedProps)) definition.properties = mergedProps;
  if (!_.isEmpty(mergedReqs)) definition.required = Array.from(mergedReqs);
  delete definition.allOf;
};

const getSchema = (objectName, fullObject) => {
  let props = {};
  const required = fullObject.required || [];
  if (isPolymorphic(fullObject)) {
    processPolymorphic(fullObject);
  }

  const object = fullObject.properties ? fullObject.properties : fullObject;

  _.forEach(object, (property, key) => {
    const schemaProperty = getSchemaProperty(
      property,
      key,
      required,
      objectName,
      object
    );
    props = _.extend(props, schemaProperty);
  });

  return props;
};

const getSchemaProperty = (property, key, required, objectName, object) => {
  let props = {};
  if (isMongodbReserved(key) === true) {
    return;
  }

  if (isMongooseProperty(property)) {
    props[key] = getMongooseSpecific(props, property);
  } else if (isMongooseArray(property)) {
    props[key] = [getMongooseSpecific(props, property)];
  } else if (isPropertyHasRef(property)) {
    processRef(property, objectName, props, key, required);
  } else if (isPolymorphic(property)) {
    processPolymorphic(property);
  } else if (!property.type || property.type === 'object') {
    props[key] = getSchema(key, property);
  } else if (property.type !== 'object') {
    const type = propertyMap(property);
    if (property.enum && _.isArray(property.enum)) {
      props[key] = { type, enum: property.enum };
    } else {
      props[key] = { type };
    }
  } else if (property.type === 'object') {
    props[key] = getSchema(key, property);
  } else if (isSimpleSchema(object)) {
    props = { type: propertyMap(object) };
  }
  if (required) {
    fillRequired(props, key, required);
  }

  if (!_.isUndefined(property.default)) {
    props[key].default = property.default;
  }

  return props;
};

const processDocumentIndex = (schema, index) => {
  //TODO: check indicies are numbers
  let isUniqueIndex = false;
  if (_.isEmpty(index)) {
    return;
  }
  if (index.unique) {
    isUniqueIndex = true;
  }
  delete index.unique;
  if (isUniqueIndex) {
    schema.index(index, { unique: true });
  } else {
    schema.index(index);
  }
};

const processMongooseDefinition = (key, customOptions) => {
  if (customOptions) {
    if (customOptions['schema-options']) {
      xSwaggerMongoose.schemaOptions[key] = customOptions['schema-options'];
    }
    if (customOptions['exclude-schema']) {
      xSwaggerMongoose.excludeSchema[key] = customOptions['exclude-schema'];
    }
    if (customOptions['additional-properties']) {
      xSwaggerMongoose.additionalProperties[key] =
        customOptions['additional-properties'];
    }
    if (customOptions.index) {
      xSwaggerMongoose.documentIndex[key] = customOptions.index;
    }
    if (customOptions.validators) {
      const validatorsDirectory = path.resolve(
        process.cwd(),
        customOptions.validators
      );
      validators = require(validatorsDirectory);
    }
  }
};

const processAdditionalProperties = (additionalProperties, objectName) => {
  let props = {};
  const customMongooseProperty = getMongooseProperty();
  _.each(additionalProperties, (property, key) => {
    const modifiedProperty = {};
    modifiedProperty[customMongooseProperty] = property;
    props = _.extend(
      props,
      getSchemaProperty(modifiedProperty, key, property.required, objectName)
    );
  });
  return props;
};

const compile = (spec, _extraDefinitions) => {
  if (!spec) throw new Error('Swagger spec not supplied');
  const swaggerJSON = convertToJSON(spec);
  if (swaggerJSON.swagger) {
    swaggerVersion = Number(swaggerJSON.swagger);
  }

  definitions = swaggerJSON.definitions;

  applyExtraDefinitions(definitions, _extraDefinitions);

  const customMongooseProperty = getMongooseProperty();

  if (swaggerJSON[customMongooseProperty]) {
    processMongooseDefinition(
      customMongooseProperty,
      swaggerJSON[customMongooseProperty]
    );
  }

  const schemas = {};
  _.forEach(definitions, (definition, key) => {
    // LOCAL CHANGE Fix index creation at document level
    let object = null;
    let options = xSwaggerMongoose.schemaOptions;
    let excludedSchema = xSwaggerMongoose.excludeSchema;

    if (definition[customMongooseProperty]) {
      processMongooseDefinition(key, definition[customMongooseProperty]);
    }
    if (excludedSchema[key]) {
      return;
    }
    object = getSchema(key, definition);
    if (options) {
      options = _.extend({}, options[customMongooseProperty], options[key]);
    }
    if (typeof excludedSchema === 'object') {
      excludedSchema =
        excludedSchema[customMongooseProperty] || excludedSchema[key];
    }
    if (object && !excludedSchema) {
      let additionalProperties = _.extend(
        {},
        xSwaggerMongoose.additionalProperties[customMongooseProperty],
        xSwaggerMongoose.additionalProperties[key]
      );
      additionalProperties = processAdditionalProperties(
        additionalProperties,
        key
      );
      object = _.extend(object, additionalProperties);
      const schema = new mongoose.Schema(object, options);
      processDocumentIndex(schema, xSwaggerMongoose.documentIndex[key]);
      schemas[key] = schema;
    }
  });

  const models = {};
  _.forEach(schemas, (schema, key) => {
    models[key] = mongoose.model(key, schema);
  });

  return {
    schemas,
    models
  };
};

const compileAsync = (spec, callback) => {
  try {
    return callback(null, compile(spec));
  } catch (err) {
    return callback({ message: err }, null);
  }
};

module.exports = {
  compile,
  compileAsync
};
