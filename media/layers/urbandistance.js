/* 
    (c) Copyright 2010 Stefan Wehrmeyer.
    Released under Creative Commons By-NC-SA: http://creativecommons.org/licenses/by-nc-sa/3.0
    By: Stefan Wehrmeyer http://stefanwehrmeyer.com
    If you want to use this software commercially, contact the author.
    
*/
var iCanHasFastBrowser = function(){
    return false;
    // One could use Chrome/Safari 5 without Worker, because it's so fast.
    if(navigator.userAgent.indexOf("Chrome")!=-1){
        return true;
    }
    return false;
};

var WorkerFacade;
if(!!window.Worker && !iCanHasFastBrowser()){
    WorkerFacade = (function(){
        return function(path){
            return new window.Worker(path);
        };
    }());
} else {
    WorkerFacade = (function(){
        var workers = {}, clb = false, loaded = false, masters = {};
        var that = function(path){
            var theworker = {};
            theworker.postMessage = function(param){
                try{
                    workers[path]({"data": param});
                }catch(err){
                    theworker.onerror(err);
                    throw err;
                }
            };
            masters[path] = theworker;
            return theworker;
        };
        that.fake = true;
        that.add = function(pth, worker){
            workers[pth] = worker;
        };
        that.toString = function(){
            return "FakeWorker('"+path+"')";
        };
        that.callback = function(c){
            if(loaded){
                c();
            } else {
                clb = c;
            }
        };
        that.callCallback = function(){
            loaded = true;
            if(!!clb){
                clb();
            }
            
        };
        // This is a global function!
        postMessage = function(param){
            for (var path in workers){
                masters[path].onmessage({"data": param});
            }
        };
        return that;
    }());
    var scr = document.createElement("SCRIPT");
    scr.src = "media/layers/urbandistanceworker.js";
    scr.type = "text/javascript";
    scr.charset = "utf-8";
    scr.onload = function(){
        WorkerFacade.callCallback();
    };
    document.body.appendChild(scr);
}

Mapnificent.addLayer("urbanDistance", function (mapnificent){
    var that = mapnificent.createLayer();
    that.tabid = "mobility";
    that.idname = "urbanDistance";
    var LOCK = false
        , callbacksForIndex = {}
        , minutesPerKm = 13
        , estimatedMinuteLimit = 600 // 10 hours travel in a city, really?
        , colorMaxAcceptableTime = 120
        , colorBaseGradientColor = 120
        , colorMaxGradientColor = 240
        , maxWalkTime = 10
        , maxWalkTravelTime = 180
        , positionCounter = -1
        , startPositions = {}
        , startPositionsCount = 0
        , stationList = []
        , stationMap = {}
        , blockGrid
        , stations
        , lines
        , defaultStartAtPosition = {"lat":52.525849,"lng":13.368919}
        , darkOverlayColor = "rgba(75,75,75,0.4)"
        , drawColor = "rgba(75,75,75,1)"
        , estimatedMaxCalculateCalls = 2000000
        , intersection = false
        , colored = false
        , colorCache = {}
        , minuteSorted = false
        , blockCountX
        , blockCountY
        , blockSize = 0.5 // in km 500 * 500 meters per block
        , conePositionBuffer;
    
    var getBlockIndizesForPosition = function(pos) {
        var indexX = Math.floor((mapnificent.env.widthInKm / mapnificent.env.latLngDiffs.lng * (pos.lng - mapnificent.env.northwest.lng)) / blockSize);
        var indexY = Math.floor((mapnificent.env.heightInKm / mapnificent.env.latLngDiffs.lat * (mapnificent.env.northwest.lat - pos.lat)) / blockSize);
        return [indexX, indexY];
    };
    var getAlternativeBlockIndizesForPosition = function(pos) {
        var indexX = Math.floor(mapnificent.getDistanceInKm(pos,{"lat": pos.lat, "lng": mapnificent.env.northwest.lng}) / blockSize);
        var indexY = Math.floor(mapnificent.getDistanceInKm(pos,{"lat": mapnificent.env.northwest.lat, "lng":pos.lng}) / blockSize);
        return [indexX, indexY];
    };
    
    var getBlockIndizesForPositionByRadius = function(pos, rad, all) {
        var indizes = getBlockIndizesForPosition(pos);
        if(rad === 0){
            return [indizes];
        }
        var results = [];
        var maxDistanceToEdge = Math.max(Math.abs(blockCountX-indizes[0]), Math.abs(indizes[1]-blockCountY));
        var nearestObjects = [];
        if(!!all){
            var start = 0;
        } else {
            var start = rad;
        }
        for(var i=start;i<maxDistanceToEdge;i++){
            for (var j=-i;j<(i+1);j++){
                var nx = indizes[0]-i;
                var ny = indizes[1]+j;
                if(nx>=0 && ny < blockCountY && ny > 0){
                    results.push([nx,ny]);
                }
                var nx = indizes[0]+i;
                var ny = indizes[1]+j;
                if(nx < blockCountX && ny < blockCountY && ny > 0){
                    results.push([nx,ny]);
                }
                if(j>-i && j<i){
                    var nx = indizes[0]+j;
                    var ny = indizes[1]-i;
                    if(nx < blockCountX && nx > 0 && ny >= 0){
                        results.push([nx,ny]);
                    }
                    var nx = indizes[0]+j;
                    var ny = indizes[1]-i;
                    if(nx < blockCountX && nx > 0 && ny >= 0){
                        results.push([nx,ny]);
                    }
                }
            }
            break; // algorithm change: break here, wait for next round. I miss iterators.
        }
        return results;
    };
    
    var updateGoby = function(e){
        var newMaxWalkTime, newMinutesPerKm;
        try{
            newMaxWalkTime = parseInt(jQuery('#'+that.idname+'-gotime').val());
        } catch(e){
            return;
        }
        var walking = jQuery("#"+that.idname+'-gobywalk').is(":checked");
        if (walking){
            newMinutesPerKm = 13;
        } else{
            newMinutesPerKm = 4; // ~15-16 km/h (traffic lights, no straigh line)
        }
        if(newMinutesPerKm != minutesPerKm || newMaxWalkTime != maxWalkTime){
            minutesPerKm = newMinutesPerKm;
            maxWalkTime = newMaxWalkTime;
            mapnificent.calculateLayer(that.idname);
            mapnificent.trigger("redraw");
        }
    };
    var updateSlider = function(index){
        return function(e, ui){
            if (startPositions[index].LOCK){return;}
            startPositions[index].LOCK = true;
//            startPositions[index].minutes = parseInt(jQuery(this).val()); // HTML5 Future
            startPositions[index].minutes = ui.value;
            mapnificent.trigger("redraw");
            jQuery("#"+that.idname+'-'+index+'-timeSpan').text(startPositions[index].minutes);
            startPositions[index].LOCK = false;
        };
    };
    
    that.getTitle = function(){
        return "Urban Distance";
    };
    var appendControlHtmlTo = function(container){
        container.html(''+
/*            '<div style="margin-right:15%;float:right;position:relative;top:-1.4em">'+
            '<input type="radio" class="'+that.idname+'-goby" id="'+that.idname+'-gobywalk" name="'+that.idname+'-goby" value="walk" checked="checked"/>'+
            '<label for="'+that.idname+'-gobywalk"> with Public Transport</label><br/>'+
            '<input type="radio" class="'+that.idname+'-goby" id="'+that.idname+'-gobybike" name="'+that.idname+'-goby" value="bike"/>'+
            '<label for="'+that.idname+'-gobybike"> with Public Transport and bike</label><br/>'+
            '<label for="'+that.idname+'-gotime">Max. time to walk/ride from/to stations: </label><input size="3" type="text" id="'+that.idname+'-gotime" value="'+maxWalkTime+'"/> minutes'+
            '</div>'+
            ''+*/
                '<div id="'+that.idname+'-positionContainer"></div>'+
            '');
        var inter = "";
        if(mapnificent.hasCompositing){
            inter = ' readonly="readonly"';
            inter = '<label class="'+that.idname+'-intersection" for="'+that.idname+'-intersection">Intersect: </label><input'+inter+' class="'+that.idname+'-intersection" type="checkbox" id="'+that.idname+'-intersection"/>';
        }
        container.after(''+
            '<div class="controlsoverlay" style="right:inherit;width:100px;left:0px !important;bottom:50px;border-left: 0px;border-bottom: 5px solid rgb(213,213,213);border-right: 5px solid rgb(213,213,213);">'+
            '<label for="'+that.idname+'-colored">Colored: </label><input type="checkbox" id="'+that.idname+'-colored"/>'+inter+
            '</div>'+
        '');
        if(!mapnificent.hasCompositing){
            jQuery('.'+that.idname+'-intersection').click(function(e){
                mapnificent.showMessage("Your browser does not support intersections, try Firefox or Opera!");
                return;
            });
        } else {
            jQuery('#'+that.idname+'-intersection').change(function(e){
                intersection = jQuery(this).is(":checked");
                if(intersection && startPositionsCount < 2){
                    mapnificent.showMessage("You need at least two points to see an intersection!");
                }
                if(intersection && jQuery('#'+that.idname+'-colored').is(":checked")){
                    jQuery('#'+that.idname+'-colored').attr("checked", null);
                    colored = false;
                }
                mapnificent.trigger("redraw");
            });            
        }
        jQuery('#'+that.idname+'-colored').change(function(e){
            colored = jQuery(this).is(":checked");
            if(colored && jQuery('#'+that.idname+'-intersection').is(":checked")){
                jQuery('#'+that.idname+'-intersection').attr("checked", null);
                intersection = false;
            }
            mapnificent.trigger("redraw");
        });
    };
    
    var openPositionWindow = function(index){
        return function(){
            startPositions[index].infowindow.setContent('<div style="margin:10px auto" class="'+that.idname+'-'+index+'-address">'+startPositions[index].address+'</span>');
            startPositions[index].infowindow.open(mapnificent.map, startPositions[index].marker);
        };
    };
    
    var addPositionHtml = function(index){
        jQuery("#"+that.idname+'-positionContainer').append('<div id="'+that.idname+'-'+index+'" style="padding:5px;margin:5px 0px;border-bottom:1px solid #bbb;">'+
                 '<span id="'+that.idname+'-'+index+'-info" style="visibility:hidden">You need at most <strong id="'+that.idname+'-'+index+'-timeSpan"></strong> minutes '+
                 'to any point in the highlighted area <small>(no guarantee)</small></span>'+
                 '<div style=""><input type="button" value="X" id="'+that.idname+'-'+index+'-remove" style="margin:2px 10px;float:right;color:#600;"/>'+
                '<div style="display:none" id="'+that.idname+'-'+index+'-slider"></div>'+ // Use HTML5 range some day here
                '<div id="'+that.idname+'-'+index+'-progressbar"></div>'+ // Use HTML5 progress some day here
                '</div>'+
                '<div style="font-size:9px" class="'+that.idname+'-'+index+'-address"></div>'+
                '</div>');
        jQuery('#'+that.idname+'-'+index).mouseover(highlightMarker(index));
        jQuery('#'+that.idname+'-'+index).mouseout(unhighlightMarker(index));
        jQuery('#'+that.idname+'-'+index+'-slider').slider({ min: 0, max: maxWalkTravelTime,
                     slide: updateSlider(index),
                     stop: updateSlider(index), 
                     value: startPositions[index].minutes,
                     animate: true
                  });
        jQuery('#'+that.idname+'-'+index+'-progressbar').progressbar({
            value: 0
        });
        jQuery("#"+that.idname+'-'+index+'-timeSpan').text(startPositions[index].minutes);
        jQuery("#"+that.idname+'-'+index+'-remove').click(function(){
            removePosition(index);
        });
    };
    
    var highlightMarker = function(index){
        return function(){
            jQuery('#'+that.idname+'-'+index+'').css('outline', '1px rgb(0,187,11) solid');
            startPositions[index].marker.setIcon("http://gmaps-samples.googlecode.com/svn/trunk/markers/green/blank.png");
        };
    };
    
    var unhighlightMarker = function(index){
        return function(){
            jQuery('#'+that.idname+'-'+index).css('outline', 'inherit');
            startPositions[index].marker.setIcon("http://gmaps-samples.googlecode.com/svn/trunk/markers/orange/blank.png");
        };
    };
    
    var setAddressForIndex = function(index){
        return function(adr){
            startPositions[index].address = adr;
            jQuery('.'+that.idname+'-'+index+'-address').text(adr);
        }; 
    };
    
    var paddZeros = function(number, zerocount){
        number = number.toString();
        var n = number.length;
        for (var k=0; k<(zerocount-n);k++){
            number = "0"+number;
        }
        return number;
    };
    
    var updateCalculationProcess = function(index, count){
        var percent = 0;
        if (count>estimatedMaxCalculateCalls){
            percent = 99;
        } else {
            percent = count / estimatedMaxCalculateCalls * 100;
        }
        jQuery('#'+that.idname+'-'+index+'-progressbar').progressbar( "value" , percent);
    };
    
    var beforeCalculate = function(index){
        jQuery('#'+that.idname+'-'+index+'-progressbar').show();
        jQuery('#'+that.idname+'-'+index+'-info').css("visibility", "hidden");
        jQuery('#'+that.idname+'-'+index+'-slider').hide();
    };
    
    var afterCalculate = function(index){
        return function(){
            jQuery('#'+that.idname+'-'+index+'-progressbar').hide();
            jQuery('#'+that.idname+'-'+index+'-info').css("visibility","visible");
            jQuery('#'+that.idname+'-'+index+'-slider').show();
            startPositions[index].ready = true;
            minuteSorted = false;
            window.setTimeout(function(){
                mapnificent.trigger("redraw");
            }, 500);
            var o = "{";
            var i=0;
            var maxminute = 0;
            for(var key in stationMap[index]){
                if (stations[key].pos.lat == startPositions[index].latlng.lat && startPositions[index].latlng.lng == stations[key].pos.lng){
                    continue;
                }
                if(stationMap[index][key].minutes > maxminute){
                    maxminute = stationMap[index][key].minutes;
                }
                // o += "#RN "+paddZeros(i, 6)+" #SN "+key+" #DN 9003201 #RD 07.06.10 #RT 0900 #FW #RP 11111111111001 #RO NNNN\n";
                o += '"'+key+'": ['+stationMap[index][key].minutes+', '+mapnificent.getDistanceInKm(startPositions[index].latlng, stations[key].pos)+'],\n';
                i += 1;
            }
            o += "}";
            // console.log(o);
        };
    };
    
    var addPosition = function(latlng){
        if(!mapnificent.inRange({"lat":latlng.lat, "lng":latlng.lng})){
            mapnificent.showMessage("Out of area!");
            return;
        }
        positionCounter += 1;
        if(startPositionsCount == 0){
            jQuery("#"+that.idname+'-positionContainer').html("");
        }
        startPositionsCount  += 1;
        var index = positionCounter;
        var marker = mapnificent.createMarker(latlng, {"draggable":true});
        marker.setIcon("http://gmaps-samples.googlecode.com/svn/trunk/markers/orange/blank.png");
        startPositions[index] = {"marker": marker, "latlng": latlng, "minutes": 15, 
            "address": "Loading...", "LOCK": false, "ready": false,
            "infowindow": new google.maps.InfoWindow({content: ""}),
            "webworker": WorkerFacade("media/layers/urbandistanceworker.js")};
        startPositions[index].webworker.onmessage = workerMessage(index);
        startPositions[index].webworker.onerror = workerError(index);
        mapnificent.getAddressForPoint(latlng, setAddressForIndex(index));
        mapnificent.addEventOnMarker("click", marker, openPositionWindow(index));
        mapnificent.addEventOnMarker("mouseover", marker, highlightMarker(index));
        mapnificent.addEventOnMarker("mouseout", marker, unhighlightMarker(index));
        mapnificent.addEventOnMarker("dragstart", marker, function(){setAddressForIndex(index)(" ");});
        mapnificent.addEventOnMarker("dragend", marker, function(mev){
            startPositions[index].ready = false;
            startPositions[index].latlng = {"lat": mev.latLng.lat(), "lng": mev.latLng.lng()};
            beforeCalculate(index);
            that.calculate(index, afterCalculate(index));
            mapnificent.getAddressForPoint(startPositions[index].latlng, setAddressForIndex(index));
        });
        addPositionHtml(index);
        that.calculate(index, afterCalculate(index));
    };
    
    var removePosition = function(index){
        if(startPositions[index].ready === false){
            startPositions[index].webworker.terminate();
        }
        minuteSorted = false;
        startPositionsCount -= 1;
        if(startPositionsCount == 0){
            jQuery("#"+that.idname+'-positionContainer').text("Click on the map to set a point!");
        }
        jQuery("#"+that.idname+'-'+index).remove();
        mapnificent.removeMarker(startPositions[index].marker);
        delete startPositions[index];
        delete stationMap[index];
        mapnificent.trigger("redraw");
    };
    
    that.activate = function(){
        for(var index in startPositions){
            jQuery("#"+that.idname+'-'+index+'-slider').slider("enable");
            startPositions[index].marker.setVisible(true);
        }
        mapnificent.bind("mapClick", addPosition);
    };
    that.deactivate = function(){
        for(var index in startPositions){
            jQuery("#"+that.idname+'-'+index+'-slider').slider("disable");
            startPositions[index].marker.setVisible(false);
        }
        mapnificent.unbind("mapClick", that.addPosition);
    };
    that.getDrawingLevel = function(){
        return 0;
    };
        
    /*
        jQuery("#loading").show();
        var obj = this;
        window.setTimeout(function(){
            obj.startCalculation();
            obj.trigger("redraw");
            jQuery("#loading").fadeOut(200);
        },0);
    };
    
        var obj = this;
        GEvent.addListener(marker, "click", function() {
            marker.openInfoWindowHtml(obj.getCurrentAddress());
            });
        this.map.addOverlay(marker);
        return marker;
        this.bind("setPosition", this.newPositionSet);
        if(this.env.setStartAtPosition !== null){
            this.setNewPosition(null,new google.maps.LatLng(this.env.setStartAtPosition.lat, this.env.setStartAtPosition.lng));
        }
    */
    
    that.setup = function(dataobjs, controlcontainer, options, gl){
        estimatedMaxCalculateCalls = options.estimatedMaxCalculateCalls || estimatedMaxCalculateCalls;
        defaultStartAtPosition = options.defaultStartAtPosition || defaultStartAtPosition;
        colorMaxGradientColor = options.colorMaxGradientColor || colorMaxGradientColor;
        colorBaseGradientColor = options.colorBaseGradientColor ||  colorBaseGradientColor;
        darkOverlayColor = options.darkOverlayColor || darkOverlayColor;
        blockCountX = Math.ceil(mapnificent.env.widthInKm / blockSize);
        blockCountY = Math.ceil(mapnificent.env.heightInKm / blockSize);
        
        stations = dataobjs[0];
        lines = dataobjs[1];
        blockGrid = [];
        for(var i=0;i<blockCountX;i+=1){
            blockGrid.push([]);
            for(var j=0;j<blockCountX;j+=1){
                blockGrid[i].push([]);
            }
        }
        stationList = [];
        for(var stationId in stations){
            for(var i=0;i<stations[stationId].reachableStations.length;i++){
                if(!stations[stationId].reachableStations[i].minutes && stations[stationId].reachableStations[i].minutes !== 0){
                    stations[stationId].reachableStations[i].minutes = 2;
                }
                if(!stations[stationId].reachableStations[i].stay && stations[stationId].reachableStations[i].stay !== 0){
                    stations[stationId].reachableStations[i].stay = 0;
                }
            }
            if (stations[stationId].pos != null){
                if(mapnificent.inRange(stations[stationId].pos)){
                    stationList.push(stationId);
                    var indizes = getBlockIndizesForPosition(stations[stationId].pos);
                    // var indizes = getBlockIndizesForPositionByRadius(stations[stationId].pos, 1, true);
                    // stations[stationId].blockIndizes = indizes.slice();
                    // blockGrid[indizes[0][0]][indizes[0][1]].push(stationId);
                    blockGrid[indizes[0]][indizes[1]].push(stationId);
                }
            }
        }
        // WebGL Cone Init
        conePositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, conePositionBuffer);
        var d, a = 0, res=50, vertices = [], count = 0;
        d = 2*Math.PI/res;
        vertices.push(0.0); vertices.push(0.0); vertices.push(0.0);
        for(var i = 0 ; i <= res ; i++ ){
           vertices.push(Math.cos(a)*distanceInMaxTime);
           vertices.push(Math.sin(a)*distanceInMaxTime);
           vertices.push(maxTime);
           a += d ;
        }
        gl.bufferData(gl.ARRAY_BUFFER, new WebGLFloatArray(vertices), gl.STATIC_DRAW);
        conePositionBuffer.itemSize = 3;
        conePositionBuffer.numItems = Math.round(vertices.length/3);
        
        appendControlHtmlTo(controlcontainer);
        if(!!WorkerFacade.fake){
            WorkerFacade.callback(function(){addPosition(defaultStartAtPosition);});
        } else {
            addPosition(defaultStartAtPosition);
        }
    };
    
    that.calculate = function(index, clb){
        callbacksForIndex[index] = clb;
        stationMap[index] = {};
        var startPos = startPositions[index].latlng
            , numberOfClosest = 3
            , minDistances=[]
            , minStations=[]
            , i = 0
            , nextStations = []
            , distances = [];
        while(i<=1 || nextStations.length == 0){
            var indizes = getBlockIndizesForPositionByRadius(startPos, i);
            for(var j=0;j<indizes.length;j+=1){
                if(blockGrid[indizes[j][0]][indizes[j][1]].length>0){
                    nextStations = jQuery.merge(nextStations, blockGrid[indizes[j][0]][indizes[j][1]]);
                }
            }
            i += 1;
            if(nextStations.length>10){
                i += 1;
            }
        }
        for(var k=0;k<nextStations.length;k++){
            distances.push(mapnificent.getDistanceInKm(startPos, stations[nextStations[k]].pos));
        }
        startPositions[index].webworker.postMessage({"fromStations": nextStations, "blockGrid": blockGrid, "position": startPos, 
            "stations": stations, "lines": lines, "distances": distances, "blockGrid": blockGrid,
            "maxWalkTime": maxWalkTime, "minutesPerKm": minutesPerKm, "estimatedMinuteLimit": estimatedMinuteLimit});
    };
    
    var workerMessage = function(index){
        return function(event){
            if(event.data.status == "done"){
                stationMap[index] = event.data.stationMap;
                callbacksForIndex[index]();
            } else if (event.data.status == "working"){
                updateCalculationProcess(index, event.data.at);
            }
        };
    };
    
    var workerError = function(index){
        return function(error){
            console.error(index, "Worker: "+error.message);
            throw error;
        };
    };
    
    var getColorFor = function(min){
        if(min == 0){min = 1;}
        if(typeof(colorCache[min]) === "undefined"){
            colorCache[min] = "hsla("+(colorBaseGradientColor - Math.floor(min/colorMaxAcceptableTime*(colorBaseGradientColor+colorMaxGradientColor)))+", 100%, 50%, 0.75)";
        }
        return colorCache[min];
    };
    
    that.getTimeForStationId = function(stid){
        return stationMap[0][stid].minutes;
    };

    var drawMinuteCircle = function(ctx, pos, minutes, minuteValue, prefunc){
        var mins = Math.min((minuteValue - minutes),maxWalkTime);
        var radius = Math.max(mins * pixelPerMinute, 1);
        var nxy = mapnificent.getCanvasXY(pos);
        try {
            if(prefunc){
                prefunc(ctx, pos, minutes, minuteValue, mins, nxy, radius);
            }
           ctx.moveTo(nxy.x,nxy.y);
           ctx.arc(nxy.x,nxy.y,radius, 0, mapnificent.circleRadians, true);
            // ctx.fillRect(xy.x-radius, xy.y-radius, radius*2, radius*2);
            // ctx.font = "8pt Arial";
            // ctx.fillText(""+parseInt(minutes), nxy.x,nxy.y);
            // ctx.textAlign = "center";
        }catch(e){
            console.log(e);
            console.log(pos.lat, pos.lng);
            console.log(nxy.x, nxy.y);
            console.log(radius);
            console.log(mapnificent.circleRadians);
        }
    };
    
    
    var addMinuteGradient = function(ctx, pos, minutes, minuteValue, mins, nxy, radius){
        var grad = ctx.createRadialGradient(nxy.x,nxy.y,0,nxy.x,nxy.y,radius);  
        grad.addColorStop(0, getColorFor(minutes));
        grad.addColorStop(0.5, getColorFor(Math.floor(minutes + (mins/2))));
        grad.addColorStop(1, getColorFor(minutes+mins));
        ctx.fillStyle = grad;
    };
    
    var fillGreyArea = function(ctx){
        if(intersection){
            ctx.globalCompositeOperation = "source-out";
        } else {
            ctx.globalCompositeOperation = "source-over";
        }
        ctx.fillStyle = darkOverlayColor;
        var xy = mapnificent.getCanvasXY(mapnificent.env.northwest);
        ctx.fillRect(xy.x,xy.y,mapnificent.env.map_width,mapnificent.env.map_height);
    };
    
    var redrawTransparent = function(ctx){
        if(!intersection){
           fillGreyArea(ctx);
           ctx.globalCompositeOperation = "destination-out";
        } else {
            ctx.globalCompositeOperation = "source-over";
        }
        var count = 0;
        ctx.fillStyle = drawColor;
        for(var index in startPositions){
            if (!startPositions[index].ready){continue;}
            if(count == 1 && intersection){
                ctx.globalCompositeOperation = "destination-in";
            }
            ctx.beginPath();
            drawMinuteCircle(ctx, startPositions[index].latlng, 0, startPositions[index].minutes);
            if(!jQuery.browser.opera && !intersection){
                ctx.fill();
            }
            for (var i=0; i<stationList.length;i++){
                var stationId = stationList[i];
                var station = stations[stationId];
                if (typeof station.pos !== "object" || station.pos === null){continue;}
                if (typeof stationMap[index][stationId] === "undefined"){continue;}
                if (stationMap[index][stationId].minutes > startPositions[index].minutes){continue;}
                if(!jQuery.browser.opera  && !intersection){
                    ctx.beginPath();
                }
                drawMinuteCircle(ctx, station.pos, stationMap[index][stationId].minutes, startPositions[index].minutes);
                if(!jQuery.browser.opera && !intersection){
                     ctx.fill();
                }
            }
            if(jQuery.browser.opera || intersection){
               ctx.fill();
            }
            count += 1;
        }
        if(intersection){
            fillGreyArea(ctx);
        }
    };
    
    var getStationMinuteList = function(){
        var sml = [];
        for (var i=0; i<stationList.length;i++){
            var smallestIndex = false, smallestMinute = Infinity;
            for(var index in startPositions){
                if(typeof(stationMap[index][stationList[i]]) !== "undefined" &&
                        stationMap[index][stationList[i]].minutes < smallestMinute){
                    smallestMinute = stationMap[index][stationList[i]].minutes;
                    smallestIndex = index;
                }
            }
            if (smallestIndex !== false){
                sml.push([smallestIndex, smallestMinute, stationList[i]]);
            }
        }
        return sml;
    };
    
    var sortByMinutes = function(){
        minuteSorted = getStationMinuteList();
        minuteSorted.sort(function(a,b){
            return ((a[1] < b[1]) ? -1 : ((a[1] > b[1]) ? 1 : 0));
        });
    };
    
    var redrawColored = function(ctx){
        if(minuteSorted == false){
            sortByMinutes();
        }
        for(var i=(minuteSorted.length-1); i>=0;i--){
            var stationId = minuteSorted[i][2];
            var index = minuteSorted[i][0];
            var station = stations[stationId];
            if (typeof station.pos !== "object" || station.pos === null){continue;}
            if (typeof stationMap[index][stationId] === "undefined"){continue;}
            if (stationMap[index][stationId].minutes > minuteSorted[i][1]){continue;}
            ctx.beginPath();
            drawMinuteCircle(ctx, station.pos, stationMap[index][stationId].minutes, startPositions[index].minutes, addMinuteGradient);
            ctx.fill();
        }
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(255,255,255,1)";
        var xy = mapnificent.getCanvasXY(mapnificent.env.northwest);
        ctx.fillRect(xy.x,xy.y,mapnificent.env.map_width,mapnificent.env.map_height);
        ctx.restore();
    };
    
    that.redrawWebGL = function(gl){
        // perspective(45, gl.viewportWidth / gl.viewportHeight, 0.1, maxTime);
        ortho(0
            , mapnificent.canvas.width
            , 0
            , mapnificent.canvas.height
            , 0, maxTime);
        // ortho(-100
        //     , 100
        //     , -100
        //     , 100
        //     , 0.1, maxTime*2);
        // ortho(-20000,20000,-20000,20000, 0, maxTime*2);
        // ortho projection
        loadIdentity();
        mvTranslate([0,0, -1.0]);
        // mvRotate(180, [0.0, 1.0, 0.0]);
        var index = 0;
        for(var i=0; i<stationList.length;i++){
            var stationId = stationList[i];
            // if(stationId != '9003201'){continue;}
            var station = stations[stationId];
            if (typeof station.pos !== "object" || station.pos === null){continue;}
            if (typeof stationMap[index][stationId] === "undefined"){continue;}
            if (stationMap[index][stationId].minutes > startPositions[index].minutes){continue;}
            mvPushMatrix();
            var minutes = stationMap[index][stationId].minutes;
            var minuteValue = startPositions[index].minutes;
            var mins = Math.min((minuteValue - minutes),maxWalkTime);
            var radius = Math.max(mins * pixelPerMinute, 1);
            var nxy = mapnificent.getCanvasXY(station.pos);
            console.log(radius, maxTime* pixelPerMinute);
            // mvScale([1.0, 1.0, 1.0]);
            mvTranslate([nxy.x, mapnificent.canvas.height-nxy.y, -mins]);
            console.log(nxy.x, mapnificent.canvas.height-nxy.y);
            console.log(mapnificent.canvas.width, mapnificent.canvas.height);
            gl.bindBuffer(gl.ARRAY_BUFFER, conePositionBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexPositionAttribute, conePositionBuffer.itemSize, gl.FLOAT, false, 0, 0);
            setMatrixUniforms(gl);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, conePositionBuffer.numItems);

            // gl.drawArrays(gl.TRIANGLES, 0, conePositionBuffer.numItems); // bad one
            mvPopMatrix();
        }
    };
    
    that.redraw = function(ctx){
        pixelPerMinute = (1/minutesPerKm) * mapnificent.env.pixelPerKm;
        that.redrawWebGL(ctx);
        return;
        ctx.save();
        if (colored){
            redrawColored(ctx);
        } else {
            redrawTransparent(ctx);
        }
        ctx.restore();
    };
    
    return that;
});